import type { WorkerRunExitMessage } from '../shared/workerControl'
import { clampTimerDelayMs } from '../shared/workerControl'
import type { EventFlushQueue } from './eventFlush'
import { planAfterRunExit } from './oneShot'
import type { ReliableDeliveryQueue, ReliableDeliverySend } from './reliableDelivery'

export const RECONNECT_INITIAL_DELAY_MS = 1_000
export const RECONNECT_MAX_DELAY_MS = 30_000

export interface ReconnectClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

export interface ReconnectPolicy {
  noteDisconnect(runIds?: Iterable<string>): void
  noteOpen(): void
  /** Mark one pending run adopted (resume) or terminally handled (ACK/reject). */
  noteHandled(runId: string): void
  isExpired(): boolean
  remainingMs(): number
  setTimeoutMs(ms: number): void
  resetBackoff(): void
  scheduleReconnect(onReconnect: () => void, onExpired: () => void): void
  cancel(): void
}

const systemClock: ReconnectClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
}

/**
 * Capped exponential reconnect delays with one deadline measured from the first
 * disconnect. A TCP/WebSocket open does not reset that deadline; it clears only
 * after every pending run is resumed or terminally handled.
 *
 * The deadline is enforced by its own watchdog rather than only by reconnect
 * scheduling, because the worst case is a *successful* reconnect where the
 * server never resumes or rejects the run: nothing would ever reschedule, so
 * without the watchdog the worker would wait forever.
 */
export function createReconnectPolicy(opts: {
  timeoutMs: number
  clock?: ReconnectClock
  initialDelayMs?: number
  maxDelayMs?: number
  /** Invoked once the delivery window elapses, connected or not. */
  onExpired?: () => void
}): ReconnectPolicy {
  const clock = opts.clock ?? systemClock
  const initialDelayMs = opts.initialDelayMs ?? RECONNECT_INITIAL_DELAY_MS
  const maxDelayMs = opts.maxDelayMs ?? RECONNECT_MAX_DELAY_MS
  const onDeadline = opts.onExpired
  let timeoutMs = clampTimerDelayMs(opts.timeoutMs)
  let delayMs = initialDelayMs
  let outageStartedAt: number | null = null
  let awaiting = new Set<string>()
  let timer: unknown = null
  let deadlineTimer: unknown = null

  const cancelReconnect = (): void => {
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }

  const remainingMs = (): number => {
    if (outageStartedAt === null) return Number.POSITIVE_INFINITY
    return Math.max(0, outageStartedAt + timeoutMs - clock.now())
  }

  const isExpired = (): boolean => outageStartedAt !== null && remainingMs() === 0

  const disarmDeadline = (): void => {
    if (deadlineTimer !== null) {
      clock.clearTimeout(deadlineTimer)
      deadlineTimer = null
    }
  }

  const armDeadline = (): void => {
    if (!onDeadline || outageStartedAt === null) return
    disarmDeadline()
    deadlineTimer = clock.setTimeout(() => {
      deadlineTimer = null
      if (isExpired()) onDeadline()
    }, clampTimerDelayMs(remainingMs()))
  }

  const cancel = (): void => {
    cancelReconnect()
    disarmDeadline()
  }

  const clearOutage = (): void => {
    outageStartedAt = null
    awaiting = new Set()
    delayMs = initialDelayMs
    cancel()
  }

  return {
    noteDisconnect(runIds: Iterable<string> = []): void {
      const ids = [...runIds]
      if (ids.length === 0) return
      if (outageStartedAt === null) outageStartedAt = clock.now()
      awaiting = new Set(ids)
      armDeadline()
    },
    noteOpen(): void {
      // Keep the deadline armed: connecting is not delivery.
      cancelReconnect()
    },
    noteHandled(runId: string): void {
      if (awaiting.size === 0) return
      awaiting.delete(runId)
      if (awaiting.size === 0) clearOutage()
    },
    isExpired,
    remainingMs,
    setTimeoutMs(ms: number): void {
      if (!Number.isFinite(ms) || ms <= 0) return
      timeoutMs = clampTimerDelayMs(ms)
      if (deadlineTimer !== null || outageStartedAt !== null) armDeadline()
    },
    resetBackoff(): void {
      delayMs = initialDelayMs
      if (awaiting.size === 0) {
        outageStartedAt = null
        cancel()
      }
    },
    cancel,
    scheduleReconnect(onReconnect, onExpired): void {
      cancelReconnect()
      if (isExpired()) {
        onExpired()
        return
      }
      const wait = clampTimerDelayMs(Math.min(delayMs, remainingMs()))
      delayMs = Math.min(delayMs * 2, maxDelayMs)
      timer = clock.setTimeout(() => {
        timer = null
        if (isExpired()) onExpired()
        else onReconnect()
      }, wait)
    },
  }
}

/**
 * Run ids the server refused, remembered briefly so a `run:reject` that lands
 * before the local handle exists still cancels it. Bounded FIFO: a hostile or
 * buggy server cannot grow worker memory by rejecting unknown ids.
 */
export interface RejectedRunLedger {
  reject(runId: string): void
  isRejected(runId: string): boolean
  clear(runId: string): void
  readonly size: number
}

export const DEFAULT_REJECTED_RUN_LIMIT = 256

export function createRejectedRunLedger(limit = DEFAULT_REJECTED_RUN_LIMIT): RejectedRunLedger {
  const ids = new Set<string>()
  return {
    reject(runId: string): void {
      ids.delete(runId)
      ids.add(runId)
      while (ids.size > limit) {
        const oldest = ids.values().next()
        if (oldest.done) break
        ids.delete(oldest.value)
      }
    },
    isRejected: (runId: string) => ids.has(runId),
    clear: (runId: string) => {
      ids.delete(runId)
    },
    get size() {
      return ids.size
    },
  }
}

/**
 * Install a freshly started run's handle unless the server already rejected the
 * run. A rejected handle is cancelled instead of registered, so a reject that
 * raced local startup can never leave an orphaned child process behind.
 */
export async function installUnlessRejected<H extends { cancel(): Promise<void> }>(
  ledger: RejectedRunLedger,
  runId: string,
  handle: H,
  handles: Map<string, H>
): Promise<boolean> {
  if (!ledger.isRejected(runId)) {
    handles.set(runId, handle)
    return true
  }
  ledger.clear(runId)
  handles.delete(runId)
  await handle.cancel()
  return false
}

/** Union of executing run IDs and runs that still have unacked delivery. */
export function pendingRunIds(
  activeIds: Iterable<string>,
  deliveryQueues: Map<string, Pick<ReliableDeliveryQueue, 'pending' | 'terminalAcknowledged'>>
): string[] {
  const ids = new Set<string>()
  for (const id of activeIds) ids.add(id)
  for (const [id, queue] of deliveryQueues) {
    if (queue.pending().length > 0 || !queue.terminalAcknowledged) ids.add(id)
  }
  return [...ids]
}

export function hasPendingDelivery(
  queues: Map<string, Pick<ReliableDeliveryQueue, 'terminalAcknowledged'>>
): boolean {
  for (const queue of queues.values()) {
    if (!queue.terminalAcknowledged) return true
  }
  return false
}

export function shutdownExitCode(opts: { deliveryExpired: boolean }): 0 | 1 {
  return opts.deliveryExpired ? 1 : 0
}

export function shouldShutdownAfterDelivery(opts: {
  shuttingDown: boolean
  hasPendingDelivery: boolean
  env?: NodeJS.ProcessEnv
}): boolean {
  if (opts.shuttingDown) return false
  return planAfterRunExit(opts.env, { hasPendingDelivery: opts.hasPendingDelivery }) === 'exit'
}

export function holdAllSends(
  queues: Map<string, Pick<ReliableDeliveryQueue, 'holdSends'>>
): void {
  for (const queue of queues.values()) queue.holdSends()
}

export type DeliveryAckKind = 'ignored' | 'prefix' | 'terminal'

export function applyDeliveryAck(
  delivery: Pick<ReliableDeliveryQueue, 'acknowledge' | 'pending' | 'terminalAcknowledged'>,
  sequence: number
): DeliveryAckKind {
  const wasTerminal = delivery.terminalAcknowledged
  const pendingBefore = delivery.pending().length
  delivery.acknowledge(sequence)
  if (delivery.terminalAcknowledged && !wasTerminal) return 'terminal'
  if (delivery.pending().length < pendingBefore) return 'prefix'
  return 'ignored'
}

export async function rejectAssignedRun<H extends { cancel(): Promise<void> }>(opts: {
  runId: string
  handles: Map<string, H>
  deliveryQueues: Map<string, unknown>
}): Promise<{ cancelled: boolean; removed: boolean; handle?: H }> {
  const handle = opts.handles.get(opts.runId)
  const removed = opts.deliveryQueues.delete(opts.runId)
  opts.handles.delete(opts.runId)
  if (handle) await handle.cancel()
  return { cancelled: Boolean(handle), removed, handle }
}

/** Flush trailing events, then enqueue the terminal frame after them. */
export async function recordLocalExit(
  events: Pick<EventFlushQueue, 'flush'>,
  delivery: Pick<ReliableDeliveryQueue, 'enqueue'>,
  frame: Omit<WorkerRunExitMessage, 'sequence'>
): Promise<void> {
  try {
    await events.flush()
  } catch {
    // Send failures are deferred; buffered events should already be on the spool.
  }
  delivery.enqueue(frame)
}

/**
 * Apply a server resume cursor and replay everything above it. Returns whether
 * the cursor was accepted — an unusable cursor means the run was *not* adopted,
 * so the outage deadline must keep running.
 */
export async function replayFromCursor(
  delivery: ReliableDeliveryQueue,
  cursor: number,
  send: ReliableDeliverySend
): Promise<boolean> {
  const accepted = await delivery.resumeAfter(cursor)
  if (!accepted) return false
  await delivery.drain(send)
  return true
}

export async function expireDeliveryRecovery(opts: {
  handles: Map<string, { cancel(): Promise<void> }>
  pendingRunIds: string[]
}): Promise<{ cancelledRunIds: string[]; exitCode: 1; pendingRunIds: string[] }> {
  const cancelledRunIds = [...opts.handles.keys()]
  await Promise.allSettled([...opts.handles.values()].map((handle) => handle.cancel()))
  return { cancelledRunIds, exitCode: 1, pendingRunIds: opts.pendingRunIds }
}
