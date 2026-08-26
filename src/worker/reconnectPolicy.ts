import type { WorkerRunExitMessage } from '../shared/workerControl'
import type { EventFlushQueue } from './eventFlush'
import type { ReliableDeliveryQueue, ReliableDeliverySend } from './reliableDelivery'

export const RECONNECT_INITIAL_DELAY_MS = 1_000
export const RECONNECT_MAX_DELAY_MS = 30_000

export interface ReconnectClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

export interface ReconnectPolicy {
  noteDisconnect(): void
  noteOpen(): void
  /** Ends the current outage after run:resume or a covering ACK. */
  noteAdopted(): void
  isExpired(): boolean
  remainingMs(): number
  setTimeoutMs(ms: number): void
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
 * disconnect. A TCP/WebSocket open does not reset that deadline; only adoption
 * (resume or covering ACK) does.
 */
export function createReconnectPolicy(opts: {
  timeoutMs: number
  clock?: ReconnectClock
  initialDelayMs?: number
  maxDelayMs?: number
}): ReconnectPolicy {
  const clock = opts.clock ?? systemClock
  const initialDelayMs = opts.initialDelayMs ?? RECONNECT_INITIAL_DELAY_MS
  const maxDelayMs = opts.maxDelayMs ?? RECONNECT_MAX_DELAY_MS
  let timeoutMs = opts.timeoutMs
  let delayMs = initialDelayMs
  let outageStartedAt: number | null = null
  let timer: unknown = null

  const cancel = (): void => {
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

  return {
    noteDisconnect(): void {
      if (outageStartedAt === null) outageStartedAt = clock.now()
    },
    noteOpen(): void {
      cancel()
    },
    noteAdopted(): void {
      cancel()
      outageStartedAt = null
      delayMs = initialDelayMs
    },
    isExpired,
    remainingMs,
    setTimeoutMs(ms: number): void {
      if (Number.isFinite(ms) && ms > 0) timeoutMs = ms
    },
    cancel,
    scheduleReconnect(onReconnect, onExpired): void {
      cancel()
      if (isExpired()) {
        onExpired()
        return
      }
      const wait = Math.min(delayMs, remainingMs())
      delayMs = Math.min(delayMs * 2, maxDelayMs)
      timer = clock.setTimeout(() => {
        timer = null
        if (isExpired()) onExpired()
        else onReconnect()
      }, wait)
    },
  }
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

/** Flush trailing events, then enqueue the terminal frame after them. */
export async function recordLocalExit(
  events: Pick<EventFlushQueue, 'flush'>,
  delivery: Pick<ReliableDeliveryQueue, 'enqueue'>,
  frame: Omit<WorkerRunExitMessage, 'sequence'>
): Promise<void> {
  await events.flush()
  delivery.enqueue(frame)
}

export async function replayFromCursor(
  delivery: ReliableDeliveryQueue,
  cursor: number,
  send: ReliableDeliverySend
): Promise<void> {
  delivery.resumeAfter(cursor)
  await delivery.drain(send)
}

export async function expireDeliveryRecovery(opts: {
  handles: Map<string, { cancel(): Promise<void> }>
  pendingRunIds: string[]
}): Promise<{ cancelledRunIds: string[]; exitCode: 1; pendingRunIds: string[] }> {
  const cancelledRunIds = [...opts.handles.keys()]
  await Promise.allSettled([...opts.handles.values()].map((handle) => handle.cancel()))
  return { cancelledRunIds, exitCode: 1, pendingRunIds: opts.pendingRunIds }
}
