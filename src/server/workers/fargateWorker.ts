/**
 * Fargate worker factory: one ECS task per run. Selected with
 * CONDUIT_WORKER_FACTORY=fargate.
 *
 * Each run launches the conduit-worker task definition with container env
 * overrides (CONDUIT_WORKER_ID=fargate-<runId>, CONDUIT_SERVER_URL). The task
 * connects back to this server's /ws/worker control plane and the factory
 * dispatches the RunSpec to that exact worker via assignTo. When the run exits
 * (or is cancelled/fails) the task is stopped.
 *
 * CONDUIT_WORKER_TOKEN: prefer baking it into the task definition as a
 * Secrets Manager secret (task def `secrets`), so it never appears in
 * DescribeTask output. CONDUIT_FARGATE_WORKER_TOKEN is available as a plain
 * env override for dev, but leaks into the ECS API — do not use in production.
 *
 * Required env: CONDUIT_FARGATE_CLUSTER, CONDUIT_FARGATE_TASK_DEFINITION,
 * CONDUIT_FARGATE_SUBNETS (comma-separated), CONDUIT_SERVER_URL (or
 * CONDUIT_BASE_URL). AWS credentials/region come from the standard SDK chain
 * (env, shared config, instance/pod role).
 * Optional env: CONDUIT_FARGATE_CONTAINER_NAME (default "worker"),
 * CONDUIT_FARGATE_SECURITY_GROUPS (comma-separated),
 * CONDUIT_FARGATE_ASSIGN_PUBLIC_IP (default "ENABLED" — needed for the task to
 * reach the internet without NAT), CONDUIT_FARGATE_PLATFORM_VERSION,
 * CONDUIT_WORKER_CONNECT_TIMEOUT_MS (default 600000).
 */
import { ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs'
import type { RunSpec, WorkerEventSink, WorkerFactory, WorkerHandle } from '../../shared/worker'
import type { WorkerControlPlane } from '../workerControl'
import { WORKER_CONNECT_TIMEOUT_MS } from '../workerControl'
import { resolveWorkerServerUrl } from './cloudConfig'
import { reporter } from '../observability'

export interface FargateWorkerConfig {
  cluster: string
  taskDefinition: string
  containerName: string
  subnets: string[]
  securityGroups: string[]
  assignPublicIp: 'ENABLED' | 'DISABLED'
  platformVersion?: string
  serverUrl: string
  workerToken?: string
  connectTimeoutMs: number
}

export function resolveFargateConfig(env: NodeJS.ProcessEnv = process.env): FargateWorkerConfig {
  const missing: string[] = []
  const cluster = env.CONDUIT_FARGATE_CLUSTER?.trim()
  const taskDefinition = env.CONDUIT_FARGATE_TASK_DEFINITION?.trim()
  const subnets = (env.CONDUIT_FARGATE_SUBNETS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!cluster) missing.push('CONDUIT_FARGATE_CLUSTER')
  if (!taskDefinition) missing.push('CONDUIT_FARGATE_TASK_DEFINITION')
  if (subnets.length === 0) missing.push('CONDUIT_FARGATE_SUBNETS')
  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} required when CONDUIT_WORKER_FACTORY=fargate`)
  }
  const publicIp = env.CONDUIT_FARGATE_ASSIGN_PUBLIC_IP?.trim().toUpperCase()
  return {
    cluster: cluster!,
    taskDefinition: taskDefinition!,
    containerName: env.CONDUIT_FARGATE_CONTAINER_NAME?.trim() || 'worker',
    subnets,
    securityGroups: (env.CONDUIT_FARGATE_SECURITY_GROUPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    assignPublicIp: publicIp === 'DISABLED' ? 'DISABLED' : 'ENABLED',
    platformVersion: env.CONDUIT_FARGATE_PLATFORM_VERSION?.trim() || undefined,
    serverUrl: resolveWorkerServerUrl(env),
    workerToken: env.CONDUIT_FARGATE_WORKER_TOKEN?.trim() || undefined,
    connectTimeoutMs: WORKER_CONNECT_TIMEOUT_MS,
  }
}

export class FargateWorkerFactory implements WorkerFactory {
  readonly kind = 'fargate'

  constructor(
    private controlPlane: WorkerControlPlane,
    private config: FargateWorkerConfig,
    private ecs: ECSClient = new ECSClient({})
  ) {}

  async startRun(spec: RunSpec, sink: WorkerEventSink): Promise<WorkerHandle> {
    const { runId } = spec
    const workerId = `fargate-${runId}`

    const environment = [
      { name: 'CONDUIT_SERVER_URL', value: this.config.serverUrl },
      { name: 'CONDUIT_WORKER_ID', value: workerId },
      ...(this.config.workerToken
        ? [{ name: 'CONDUIT_WORKER_TOKEN', value: this.config.workerToken }]
        : []),
    ]

    let taskArn: string
    try {
      const out = await this.ecs.send(
        new RunTaskCommand({
          cluster: this.config.cluster,
          taskDefinition: this.config.taskDefinition,
          launchType: 'FARGATE',
          platformVersion: this.config.platformVersion,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: this.config.subnets,
              securityGroups: this.config.securityGroups.length > 0 ? this.config.securityGroups : undefined,
              assignPublicIp: this.config.assignPublicIp,
            },
          },
          overrides: {
            containerOverrides: [{ name: this.config.containerName, environment }],
          },
          tags: [
            { key: 'conduit:run-id', value: runId },
            { key: 'conduit:agent-id', value: spec.agentId },
            { key: 'managed-by', value: 'conduit' },
          ],
        })
      )
      const failures = out.failures ?? []
      const arn = out.tasks?.[0]?.taskArn
      if (!arn) {
        throw new Error(
          failures.length > 0
            ? failures.map((f) => `${f.arn ?? 'task'}: ${f.reason ?? 'unknown'}`).join('; ')
            : 'RunTask returned no task'
        )
      }
      taskArn = arn
    } catch (err) {
      throw new Error(
        `Failed to start Fargate task for run ${runId}: ` +
          (err instanceof Error ? err.message : String(err)),
        { cause: err }
      )
    }

    const wrappedSink: WorkerEventSink = {
      onEvent: (ev) => sink.onEvent(ev),
      onError: (err) => sink.onError?.(err),
      onExit: (status, exitCode) => {
        sink.onExit(status, exitCode)
        void this.stopTask(taskArn, runId, `run exited (${status})`)
      },
    }

    try {
      const handle = await this.controlPlane.assignTo(workerId, spec, wrappedSink, this.config.connectTimeoutMs)
      return {
        ...handle,
        cancel: async () => {
          await handle.cancel()
          await this.stopTask(taskArn, runId, 'run cancelled')
        },
      }
    } catch (err) {
      await this.stopTask(taskArn, runId, 'assignment failed')
      throw err
    }
  }

  private async stopTask(taskArn: string, runId: string, reason: string): Promise<void> {
    try {
      await this.ecs.send(
        new StopTaskCommand({
          cluster: this.config.cluster,
          task: taskArn,
          reason: `Conduit run ${runId}: ${reason}`.slice(0, 255),
        })
      )
    } catch (err) {
      // Stopping an already-stopped task is benign; log other failures since
      // they leave billable tasks running.
      console.error(`[workers/fargate] Failed to stop task ${taskArn} (run ${runId}):`, err)
      reporter.captureException(err, {
        tags: { component: 'workers/fargate', op: 'stopTask', runId },
      })
    }
  }

  async shutdown(): Promise<void> {
    // Tasks are stopped per-run on exit; in-flight tasks self-terminate when
    // their runs end or their lease expires.
  }
}
