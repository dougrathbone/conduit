/**
 * Startup orphan partition and recovered remote-run sinks.
 *
 * Local / missing-kind orphans fail immediately (unchanged restart message).
 * Remote/eks/fargate runs with a persisted workerId stay `running` for the
 * reconnect window; a matching RecoverRun reconstructs the runner pipeline
 * from the durable log cursor. Unadopted remotes fail once when the timer fires.
 */
import type { ExecutionRun, RunnerType } from '../shared/types'
import type { WorkerHandle } from '../shared/worker'
import type { RecoverableRunBinding } from './workerControl'
import { peekWorkerControlPlane } from './workerControl'
import { getRun, getOrphanedRuns, updateRun, updateRunIfRunning } from '../main/db/queries/runs'
import { getAgent } from '../main/db/queries/agents'
import { readHighestContiguousSequence } from './runDeliveryLog'
import {
  appendRunLog,
  createRunOrchestration,
  getActiveRunIds,
  notifyRunFinalized,
  type BroadcastFn,
} from './runner'
import { reporter } from './observability'

export const DEFAULT_RECOVERABLE_KINDS = ['remote', 'eks', 'fargate'] as const

const LOCAL_RESTART_MESSAGE =
  '✗ Run did not finish — the Conduit process exited mid-run (deploy, crash, ' +
  'out-of-memory, or disk-pressure eviction). Marked failed on restart.'

export interface ReconcileOrphanedRunsOptions {
  reconnectTimeoutMs: number
  recoverableKinds?: readonly string[]
  broadcast: BroadcastFn
}

export interface OrphanReconcileHandle {
  stop(): void
  adopted(runId: string): void
}

const recoveredBindings = new Map<string, RecoverableRunBinding>()
const pendingExpiry = new Map<string, { timer: NodeJS.Timeout; cancelled: boolean }>()
let activeReconcile: OrphanReconcileHandle | null = null

function isRecoverable(run: ExecutionRun, kinds: ReadonlySet<string>): boolean {
  return (
    run.status === 'running' &&
    typeof run.workerKind === 'string' &&
    kinds.has(run.workerKind) &&
    typeof run.workerId === 'string' &&
    run.workerId.length > 0
  )
}

function clearExpiry(runId: string): void {
  const pending = pendingExpiry.get(runId)
  if (!pending) return
  pending.cancelled = true
  clearTimeout(pending.timer)
  pendingExpiry.delete(runId)
}

export function stopOrphanReconciliation(): void {
  activeReconcile?.stop()
  activeReconcile = null
}

function reconnectExpiryMessage(reconnectTimeoutMs: number): string {
  return `Run did not finish — remote worker did not reconnect within ${reconnectTimeoutMs}ms after the Conduit server restarted.`
}

async function failUnadoptedRemote(
  run: ExecutionRun,
  reconnectTimeoutMs: number,
  broadcast: BroadcastFn
): Promise<void> {
  const pending = pendingExpiry.get(run.id)
  if (!pending || pending.cancelled) return
  pendingExpiry.delete(run.id)
  if (recoveredBindings.has(run.id) || getActiveRunIds().has(run.id)) return

  const current = await getRun(run.id)
  if (!current || current.status !== 'running') return
  if (recoveredBindings.has(run.id) || getActiveRunIds().has(run.id)) return

  const text = reconnectExpiryMessage(reconnectTimeoutMs)
  appendRunLog(run.id, text, run.logPath)

  const endedAt = Date.now()
  const durationMs = endedAt - run.startedAt
  const updated = await updateRunIfRunning(run.id, {
    status: 'failed',
    endedAt,
    durationMs,
    lastLine: text.slice(0, 500),
  })
  if (!updated) return

  broadcast('run:statusChange', {
    runId: run.id,
    status: 'failed',
    endedAt,
    durationMs,
  })
  reporter.captureMessage(text, 'warning', {
    tags: { component: 'server', op: 'orphanReconcile', runId: run.id },
    extra: { workerId: run.workerId, workerKind: run.workerKind, reconnectTimeoutMs },
  })
  notifyRunFinalized()
}

async function bindRecoveredRun(
  run: ExecutionRun,
  broadcast: BroadcastFn
): Promise<RecoverableRunBinding> {
  const durableSequence = await readHighestContiguousSequence(run.logPath)
  const existing = recoveredBindings.get(run.id)
  if (existing && getActiveRunIds().has(run.id)) {
    const binding = { ...existing, durableSequence }
    recoveredBindings.set(run.id, binding)
    return binding
  }

  const agent = await getAgent(run.agentId)
  const runner: RunnerType = agent?.runner ?? 'claude'
  const orch = createRunOrchestration({ run, broadcast, runner })
  const workerId = run.workerId!
  const handle: WorkerHandle = {
    runId: run.id,
    workspacePath: run.workspacePath,
    ephemeral: false,
    workerId,
    cancel: async () => {
      peekWorkerControlPlane()?.requestCancel(run.id)
    },
  }
  orch.register(handle)

  const sink = {
    ...orch.sink,
    onExit: (status: Parameters<typeof orch.sink.onExit>[0], exitCode: Parameters<typeof orch.sink.onExit>[1]) => {
      recoveredBindings.delete(run.id)
      return orch.sink.onExit(status, exitCode)
    },
  }

  const binding: RecoverableRunBinding = {
    runId: run.id,
    workerId,
    sink,
    handle,
    durableSequence,
  }
  recoveredBindings.set(run.id, binding)
  return binding
}

/**
 * Reconstruct a control-plane binding for a still-running remote/eks/fargate
 * run whose persisted workerId matches. Cursor is the contiguous prefix of the
 * persistent run log — never a DB field, never padded with marker rows.
 */
export async function recoverRemoteRun(
  runId: string,
  workerId: string,
  broadcast: BroadcastFn
): Promise<RecoverableRunBinding | undefined> {
  const run = await getRun(runId)
  if (!run) return undefined
  if (!isRecoverable(run, new Set(DEFAULT_RECOVERABLE_KINDS))) return undefined
  if (run.workerId !== workerId) return undefined

  const binding = await bindRecoveredRun(run, broadcast)
  clearExpiry(runId)
  return binding
}

export async function reconcileOrphanedRuns(
  opts: ReconcileOrphanedRunsOptions
): Promise<OrphanReconcileHandle> {
  const recoverableKinds = new Set(opts.recoverableKinds ?? DEFAULT_RECOVERABLE_KINDS)
  const orphaned = await getOrphanedRuns()
  const immediate: ExecutionRun[] = []
  const pending: ExecutionRun[] = []
  for (const run of orphaned) {
    if (isRecoverable(run, recoverableKinds)) pending.push(run)
    else immediate.push(run)
  }

  for (const run of immediate) {
    appendRunLog(run.id, LOCAL_RESTART_MESSAGE, run.logPath)
    await updateRun(run.id, { status: 'failed', endedAt: Date.now() })
  }
  if (immediate.length > 0) {
    console.log(`[server] Marked ${immediate.length} orphaned run(s) as failed`)
    reporter.captureMessage(
      `Marked ${immediate.length} orphaned run(s) as failed on startup — the previous Conduit ` +
        `process exited mid-run (deploy, crash, OOM, or disk-pressure eviction).`,
      'warning',
      {
        tags: { component: 'server', op: 'orphanReconcile' },
        extra: { count: immediate.length, runIds: immediate.map((r) => r.id) },
      }
    )
  }

  const handle: OrphanReconcileHandle = {
    stop() {
      for (const runId of [...pendingExpiry.keys()]) clearExpiry(runId)
      if (activeReconcile === handle) activeReconcile = null
    },
    adopted(runId: string) {
      clearExpiry(runId)
    },
  }

  for (const run of pending) {
    const timer = setTimeout(() => {
      void failUnadoptedRemote(run, opts.reconnectTimeoutMs, opts.broadcast)
    }, opts.reconnectTimeoutMs)
    timer.unref()
    pendingExpiry.set(run.id, { timer, cancelled: false })
  }

  activeReconcile = handle
  return handle
}
