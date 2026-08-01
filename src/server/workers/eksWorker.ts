/**
 * EKS worker factory: one Kubernetes Job per run. Selected with
 * CONDUIT_WORKER_FACTORY=eks.
 *
 * Each run gets a Job named conduit-run-<runId> running the conduit-worker
 * image with CONDUIT_WORKER_ID=eks-<runId>. The pod connects back to this
 * server's /ws/worker control plane (token from a K8s Secret) and the factory
 * dispatches the RunSpec to that exact worker via assignTo — so secrets only
 * ever travel over the authenticated WSS channel, never through the Job spec.
 * When the run exits (or is cancelled/fails) the Job is deleted; finished Jobs
 * also self-clean via ttlSecondsAfterFinished.
 *
 * Required env: CONDUIT_EKS_WORKER_IMAGE, CONDUIT_SERVER_URL (or CONDUIT_BASE_URL),
 * plus CONDUIT_WORKER_TOKEN must match the Secret's value.
 * Optional env: CONDUIT_EKS_NAMESPACE (default "default"),
 * CONDUIT_EKS_TOKEN_SECRET_NAME/KEY (default "conduit-worker-token"/"token"),
 * CONDUIT_EKS_SERVICE_ACCOUNT, CONDUIT_EKS_IMAGE_PULL_POLICY (default
 * "IfNotPresent"), CONDUIT_EKS_JOB_TTL_SECONDS (default 300),
 * CONDUIT_EKS_CPU_REQUEST/LIMIT, CONDUIT_EKS_MEMORY_REQUEST/LIMIT,
 * CONDUIT_WORKER_CONNECT_TIMEOUT_MS (default 600000 — pod startup + image pull).
 * Cluster credentials come from the standard kubeconfig resolution
 * (KUBECONFIG, ~/.kube/config, or in-cluster service account).
 */
import { BatchV1Api, KubeConfig } from '@kubernetes/client-node'
import type { RunSpec, WorkerEventSink, WorkerFactory, WorkerHandle } from '../../shared/worker'
import type { WorkerControlPlane } from '../workerControl'
import { WORKER_CONNECT_TIMEOUT_MS } from '../workerControl'
import { resolveWorkerServerUrl } from './cloudConfig'
import { reporter } from '../observability'

export interface EksWorkerConfig {
  namespace: string
  image: string
  serverUrl: string
  tokenSecretName: string
  tokenSecretKey: string
  serviceAccount?: string
  imagePullPolicy: string
  jobTtlSeconds: number
  connectTimeoutMs: number
  resources?: {
    requests?: { cpu?: string; memory?: string }
    limits?: { cpu?: string; memory?: string }
  }
}

export function resolveEksConfig(env: NodeJS.ProcessEnv = process.env): EksWorkerConfig {
  const image = env.CONDUIT_EKS_WORKER_IMAGE?.trim()
  if (!image) {
    throw new Error('CONDUIT_EKS_WORKER_IMAGE is required when CONDUIT_WORKER_FACTORY=eks')
  }
  const requests = {
    cpu: env.CONDUIT_EKS_CPU_REQUEST?.trim() || undefined,
    memory: env.CONDUIT_EKS_MEMORY_REQUEST?.trim() || undefined,
  }
  const limits = {
    cpu: env.CONDUIT_EKS_CPU_LIMIT?.trim() || undefined,
    memory: env.CONDUIT_EKS_MEMORY_LIMIT?.trim() || undefined,
  }
  return {
    namespace: env.CONDUIT_EKS_NAMESPACE?.trim() || 'default',
    image,
    serverUrl: resolveWorkerServerUrl(env),
    tokenSecretName: env.CONDUIT_EKS_TOKEN_SECRET_NAME?.trim() || 'conduit-worker-token',
    tokenSecretKey: env.CONDUIT_EKS_TOKEN_SECRET_KEY?.trim() || 'token',
    serviceAccount: env.CONDUIT_EKS_SERVICE_ACCOUNT?.trim() || undefined,
    imagePullPolicy: env.CONDUIT_EKS_IMAGE_PULL_POLICY?.trim() || 'IfNotPresent',
    jobTtlSeconds: Number(env.CONDUIT_EKS_JOB_TTL_SECONDS) || 300,
    connectTimeoutMs: WORKER_CONNECT_TIMEOUT_MS,
    resources:
      requests.cpu || requests.memory || limits.cpu || limits.memory
        ? {
            requests: requests.cpu || requests.memory ? requests : undefined,
            limits: limits.cpu || limits.memory ? limits : undefined,
          }
        : undefined,
  }
}

export class EksWorkerFactory implements WorkerFactory {
  readonly kind = 'eks'
  private batchApi: BatchV1Api

  constructor(
    private controlPlane: WorkerControlPlane,
    private config: EksWorkerConfig,
    batchApi?: BatchV1Api
  ) {
    if (batchApi) {
      this.batchApi = batchApi
    } else {
      const kc = new KubeConfig()
      kc.loadFromDefault()
      this.batchApi = kc.makeApiClient(BatchV1Api)
    }
  }

  async startRun(spec: RunSpec, sink: WorkerEventSink): Promise<WorkerHandle> {
    const { runId } = spec
    const workerId = `eks-${runId}`
    const jobName = `conduit-run-${runId}`

    // Delete the Job when the run ends for any reason. Fires into the wrapped
    // sink so it happens on normal exit, failure, and lease-loss alike.
    const wrappedSink: WorkerEventSink = {
      onEvent: (ev) => sink.onEvent(ev),
      onError: (err) => sink.onError?.(err),
      onExit: (status, exitCode) => {
        sink.onExit(status, exitCode)
        void this.deleteJob(jobName, runId)
      },
    }

    try {
      await this.batchApi.createNamespacedJob({
        namespace: this.config.namespace,
        body: this.buildJobManifest(jobName, workerId, spec),
      })
    } catch (err) {
      throw new Error(
        `Failed to create Kubernetes Job ${jobName} in namespace ${this.config.namespace}: ` +
          (err instanceof Error ? err.message : String(err)),
        { cause: err }
      )
    }

    try {
      const handle = await this.controlPlane.assignTo(workerId, spec, wrappedSink, this.config.connectTimeoutMs)
      return {
        ...handle,
        cancel: async () => {
          // Graceful first (SIGTERM via the control plane), then remove the
          // Job so the pod can't linger if the worker is wedged.
          await handle.cancel()
          await this.deleteJob(jobName, runId)
        },
      }
    } catch (err) {
      // Pod never connected / never started — remove the Job so it doesn't
      // keep retrying (backoffLimit 0, but the Job object itself remains).
      await this.deleteJob(jobName, runId)
      throw err
    }
  }

  private buildJobManifest(jobName: string, workerId: string, spec: RunSpec) {
    const labels = {
      'app.kubernetes.io/name': 'conduit-worker',
      'app.kubernetes.io/managed-by': 'conduit',
      'conduit.dev/run-id': spec.runId,
      'conduit.dev/agent-id': spec.agentId,
    }
    return {
      metadata: { name: jobName, namespace: this.config.namespace, labels },
      spec: {
        ttlSecondsAfterFinished: this.config.jobTtlSeconds,
        backoffLimit: 0,
        template: {
          metadata: { labels },
          spec: {
            restartPolicy: 'Never' as const,
            serviceAccountName: this.config.serviceAccount,
            containers: [
              {
                name: 'worker',
                image: this.config.image,
                imagePullPolicy: this.config.imagePullPolicy,
                command: ['node', 'out/worker/index.js'],
                env: [
                  { name: 'CONDUIT_SERVER_URL', value: this.config.serverUrl },
                  { name: 'CONDUIT_WORKER_ID', value: workerId },
                  {
                    name: 'CONDUIT_WORKER_TOKEN',
                    valueFrom: {
                      secretKeyRef: {
                        name: this.config.tokenSecretName,
                        key: this.config.tokenSecretKey,
                      },
                    },
                  },
                ],
                resources: this.config.resources,
              },
            ],
          },
        },
      },
    }
  }

  private async deleteJob(jobName: string, runId: string): Promise<void> {
    try {
      await this.batchApi.deleteNamespacedJob({
        name: jobName,
        namespace: this.config.namespace,
        propagationPolicy: 'Background',
      })
    } catch (err) {
      // 404 is fine (TTL controller beat us to it); anything else is worth a
      // signal since it leaks cluster resources.
      const status = (err as { statusCode?: number }).statusCode ?? (err as { code?: number }).code
      if (status !== 404) {
        console.error(`[workers/eks] Failed to delete Job ${jobName} (run ${runId}):`, err)
        reporter.captureException(err, {
          tags: { component: 'workers/eks', op: 'deleteJob', runId },
        })
      }
    }
  }

  async shutdown(): Promise<void> {
    // Jobs are deleted per-run on exit; a server shutdown leaves the TTL
    // controller to reap any in-flight Jobs' remains.
  }
}
