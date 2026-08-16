/**
 * Fargate worker factory: one ECS task per run. Selected with
 * CONDUIT_WORKER_FACTORY=fargate.
 *
 * Each run launches the conduit-worker task definition with container env
 * overrides (CONDUIT_WORKER_ID=fargate-<runId>, CONDUIT_SERVER_URL). The task
 * connects back to this server's /ws/worker control plane and the factory
 * dispatches the RunSpec to that exact worker via assignTo. When the run exits
 * (or is cancelled/fails) the task is stopped and DescribeTasks confirms
 * STOPPED. Factory shutdown stops every in-flight task the same way.
 *
 * CONDUIT_WORKER_TOKEN: prefer baking it into the task definition as a
 * Secrets Manager secret (task def `secrets`), so it never appears in
 * DescribeTask output. CONDUIT_FARGATE_WORKER_TOKEN is available as a plain
 * env override for dev, but leaks into the ECS API — do not use in production.
 *
 * Worker process mode is also a task-definition concern, not a RunTask
 * override: the shared image defaults to CONDUIT_PROCESS_MODE=server, so the
 * worker task def must set CONDUIT_PROCESS_MODE=worker and
 * CONDUIT_WORKER_ONE_SHOT=true. Overrides stay limited to server URL, worker
 * id, and the optional dev token so they match the Fargate contracts.
 *
 * Required env: CONDUIT_FARGATE_CLUSTER, CONDUIT_FARGATE_TASK_DEFINITION,
 * CONDUIT_FARGATE_SUBNETS (comma-separated), CONDUIT_SERVER_URL (or
 * CONDUIT_BASE_URL). AWS credentials/region come from the standard SDK chain
 * (env, shared config, instance/pod role). Optional CONDUIT_FARGATE_ROLE_ARN
 * is assumed via STS for ECS API calls.
 * Optional env: CONDUIT_FARGATE_CONTAINER_NAME (default "worker"),
 * CONDUIT_FARGATE_SECURITY_GROUPS (comma-separated),
 * CONDUIT_FARGATE_ASSIGN_PUBLIC_IP (default "ENABLED" — needed for the task to
 * reach the internet without NAT), CONDUIT_FARGATE_PLATFORM_VERSION,
 * CONDUIT_WORKER_CONNECT_TIMEOUT_MS (default 600000),
 * CONDUIT_WORKER_ASSIGN_TIMEOUT_MS (default 120000).
 *
 * E2E-only: CONDUIT_FARGATE_E2E_FAKE_ECS may point at a module under e2e/
 * that exports createFakeEcsClient(). Requires CONDUIT_E2E=1 and is forbidden
 * when NODE_ENV=production.
 */
import {
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  type ECSClientConfig,
  type RunTaskCommandInput,
  type Task,
} from '@aws-sdk/client-ecs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers'
import type { RunSpec, WorkerEventSink, WorkerFactory, WorkerHandle } from '../../shared/worker'
import type { WorkerControlPlane } from '../workerControl'
import { resolveAssignTimeoutMs, resolveConnectTimeoutMs } from '../workerControl'
import { resolveWorkerServerUrl } from './cloudConfig'
import { reporter } from '../observability'

/** Compatible Fargate allocation: 2 vCPU / 8 GiB. Enforced on every RunTask. */
export const FARGATE_WORKER_CPU = '2048'
export const FARGATE_WORKER_MEMORY_MIB = '8192'

const STOP_VERIFY_TIMEOUT_MS = 15_000
const WATCH_INITIAL_DELAY_MS = 25
const BACKOFF_CAP_MS = 2_000

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
  assignTimeoutMs?: number
  roleArn?: string
}

/** ECS client config: default SDK chain, or STS assume-role when roleArn is set. */
export function buildFargateEcsClientConfig(config: FargateWorkerConfig): ECSClientConfig {
  if (!config.roleArn) return {}
  return {
    credentials: fromTemporaryCredentials({
      params: {
        RoleArn: config.roleArn,
        RoleSessionName: 'conduit-fargate-launcher',
      },
    }),
  }
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
    connectTimeoutMs: resolveConnectTimeoutMs(env),
    assignTimeoutMs: resolveAssignTimeoutMs(env),
    roleArn: env.CONDUIT_FARGATE_ROLE_ARN?.trim() || undefined,
  }
}

/** Pure RunTask payload: startedBy, tags, 2 vCPU / 8 GiB, no secrets by default. */
export function buildFargateRunTaskInput(config: FargateWorkerConfig, spec: RunSpec): RunTaskCommandInput {
  const workerId = `fargate-${spec.runId}`
  const environment = [
    { name: 'CONDUIT_SERVER_URL', value: config.serverUrl },
    { name: 'CONDUIT_WORKER_ID', value: workerId },
    ...(config.workerToken ? [{ name: 'CONDUIT_WORKER_TOKEN', value: config.workerToken }] : []),
  ]
  return {
    cluster: config.cluster,
    taskDefinition: config.taskDefinition,
    launchType: 'FARGATE',
    startedBy: 'conduit',
    platformVersion: config.platformVersion,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: config.subnets,
        securityGroups: config.securityGroups.length > 0 ? config.securityGroups : undefined,
        assignPublicIp: config.assignPublicIp,
      },
    },
    overrides: {
      cpu: FARGATE_WORKER_CPU,
      memory: FARGATE_WORKER_MEMORY_MIB,
      containerOverrides: [{ name: config.containerName, environment }],
    },
    tags: [
      { key: 'conduit:run-id', value: spec.runId },
      { key: 'conduit:agent-id', value: spec.agentId },
      { key: 'managed-by', value: 'conduit' },
    ],
  }
}

export class FargateWorkerFactory implements WorkerFactory {
  readonly kind = 'fargate'
  private readonly ecs: ECSClient
  /** In-flight runId → task ARN. Removed once StopTask+verify finishes. */
  private readonly active = new Map<string, string>()
  /** In-flight stop+verify promises, keyed by task ARN (idempotent). */
  private readonly stopping = new Map<string, Promise<void>>()

  constructor(
    private controlPlane: WorkerControlPlane,
    private config: FargateWorkerConfig,
    ecs?: ECSClient
  ) {
    this.ecs = ecs ?? tryLoadE2eFakeEcsClient() ?? new ECSClient(buildFargateEcsClientConfig(config))
  }

  async startRun(spec: RunSpec, sink: WorkerEventSink): Promise<WorkerHandle> {
    const { runId } = spec
    const workerId = `fargate-${runId}`

    let taskArn: string
    try {
      const out = await this.ecs.send(new RunTaskCommand(buildFargateRunTaskInput(this.config, spec)))
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

    this.active.set(runId, taskArn)

    const wrappedSink: WorkerEventSink = {
      onEvent: (ev) => sink.onEvent(ev),
      onError: (err) => sink.onError?.(err),
      onExit: (status, exitCode) => {
        sink.onExit(status, exitCode)
        void this.stopTask(taskArn, runId, `run exited (${status})`)
      },
    }

    try {
      const handle = await this.assignWhenConnected(workerId, spec, wrappedSink, taskArn, runId)
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

  /**
   * Wait for assignTo, but fail fast if the task dies before the worker dials in
   * (image pull errors, capacity, crash-loop). Watcher yields first so a
   * promptly-settling assignTo wins without an extra DescribeTasks.
   */
  private async assignWhenConnected(
    workerId: string,
    spec: RunSpec,
    sink: WorkerEventSink,
    taskArn: string,
    runId: string
  ): Promise<WorkerHandle> {
    let settled = false
    const assign = this.controlPlane
      .assignTo(workerId, spec, sink, this.config.connectTimeoutMs)
      .finally(() => {
        settled = true
      })
    // Race losers must not become unhandled rejections when the watcher wins
    // and cancelAssignTo rejects this promise.
    void assign.catch(() => {})

    const watch = (async () => {
      let delay = WATCH_INITIAL_DELAY_MS
      while (!settled) {
        await sleep(delay)
        if (settled) break
        let task: Task | undefined
        try {
          task = await this.describeTask(taskArn)
        } catch (err) {
          if (settled) break
          console.error(`[workers/fargate] DescribeTasks failed for ${taskArn} (run ${runId}):`, err)
          reporter.captureException(err, {
            tags: { component: 'workers/fargate', op: 'watchTask', runId },
          })
          delay = Math.min(delay * 2, BACKOFF_CAP_MS)
          continue
        }
        if (settled) break
        if (task?.lastStatus === 'STOPPED') {
          const reason = task.stoppedReason?.trim() || 'STOPPED'
          throw new Error(
            `Fargate task for run ${runId} stopped before the worker connected: ${reason}`
          )
        }
        delay = Math.min(delay * 2, BACKOFF_CAP_MS)
      }
      return new Promise<WorkerHandle>(() => {})
    })()

    try {
      return await Promise.race([assign, watch])
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.controlPlane.cancelAssignTo(workerId, error)
      throw error
    }
  }

  private async describeTask(taskArn: string): Promise<Task | undefined> {
    const out = await this.ecs.send(
      new DescribeTasksCommand({
        cluster: this.config.cluster,
        tasks: [taskArn],
      })
    )
    return out.tasks?.[0]
  }

  private async stopTask(taskArn: string, runId: string, reason: string): Promise<void> {
    const existing = this.stopping.get(taskArn)
    if (existing) return existing

    const work = this.stopTaskOnce(taskArn, runId, reason).finally(() => {
      this.stopping.delete(taskArn)
      this.active.delete(runId)
    })
    this.stopping.set(taskArn, work)
    return work
  }

  private async stopTaskOnce(taskArn: string, runId: string, reason: string): Promise<void> {
    try {
      await this.ecs.send(
        new StopTaskCommand({
          cluster: this.config.cluster,
          task: taskArn,
          reason: `Conduit run ${runId}: ${reason}`.slice(0, 255),
        })
      )
    } catch (err) {
      if (isTaskGone(err)) return
      console.error(`[workers/fargate] Failed to stop task ${taskArn} (run ${runId}):`, err)
      reporter.captureException(err, {
        tags: { component: 'workers/fargate', op: 'stopTask', runId },
      })
      return
    }

    await this.waitUntilStopped(taskArn, runId)
  }

  private async waitUntilStopped(taskArn: string, runId: string): Promise<void> {
    let delay = 50
    const deadline = Date.now() + STOP_VERIFY_TIMEOUT_MS
    for (;;) {
      try {
        const task = await this.describeTask(taskArn)
        if (!task || task.lastStatus === 'STOPPED') return
      } catch (err) {
        if (isTaskGone(err)) return
        console.error(`[workers/fargate] Failed to describe task ${taskArn} (run ${runId}):`, err)
        reporter.captureException(err, {
          tags: { component: 'workers/fargate', op: 'describeTask', runId },
        })
        return
      }
      if (Date.now() >= deadline) {
        const message = `[workers/fargate] Task ${taskArn} (run ${runId}) did not reach STOPPED within ${STOP_VERIFY_TIMEOUT_MS}ms`
        console.error(message)
        reporter.captureMessage(message, 'error', {
          tags: { component: 'workers/fargate', op: 'waitUntilStopped', runId },
        })
        return
      }
      await sleep(delay)
      delay = Math.min(delay * 2, BACKOFF_CAP_MS)
    }
  }

  async shutdown(): Promise<void> {
    const inflight = [...this.active.entries()]
    await Promise.all(inflight.map(([runId, taskArn]) => this.stopTask(taskArn, runId, 'factory shutdown')))
  }
}

/** True for CONDUIT_E2E=1/true/yes (whitespace/case-tolerant). */
export function isConduitE2eEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CONDUIT_E2E?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/** Allowlist: resolved module path must sit under <cwd>/e2e/. */
export function isAllowlistedE2eModule(resolved: string, cwd: string = process.cwd()): boolean {
  const e2eRoot = path.resolve(cwd, 'e2e')
  const rel = path.relative(e2eRoot, path.resolve(resolved))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * E2E-only hook: load a duck-typed ECS client from CONDUIT_FARGATE_E2E_FAKE_ECS.
 * Refuses NODE_ENV=production, requires CONDUIT_E2E=1, and allowlists e2e/.
 */
export function tryLoadE2eFakeEcsClient(env: NodeJS.ProcessEnv = process.env): ECSClient | undefined {
  const spec = env.CONDUIT_FARGATE_E2E_FAKE_ECS?.trim()
  if (!spec) return undefined
  if (env.NODE_ENV === 'production') {
    throw new Error('CONDUIT_FARGATE_E2E_FAKE_ECS is forbidden when NODE_ENV=production')
  }
  if (!isConduitE2eEnabled(env)) {
    throw new Error('CONDUIT_FARGATE_E2E_FAKE_ECS requires CONDUIT_E2E=1')
  }
  const resolved = path.isAbsolute(spec) ? spec : path.resolve(spec)
  if (!isAllowlistedE2eModule(resolved)) {
    throw new Error(`CONDUIT_FARGATE_E2E_FAKE_ECS must resolve under e2e/ (got ${resolved})`)
  }
  const req = createRequire(path.join(process.cwd(), 'package.json'))
  const loaded = req(resolved) as { createFakeEcsClient?: () => ECSClient }
  const client = typeof loaded.createFakeEcsClient === 'function' ? loaded.createFakeEcsClient() : loaded
  if (!client || typeof (client as { send?: unknown }).send !== 'function') {
    throw new Error(
      `CONDUIT_FARGATE_E2E_FAKE_ECS module must export createFakeEcsClient() or a client with send() (${resolved})`
    )
  }
  console.warn(`[workers/fargate] e2e fake ECS loaded from ${resolved}`)
  return client as ECSClient
}

function isTaskGone(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /not found|does not exist|unknown task/i.test(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
