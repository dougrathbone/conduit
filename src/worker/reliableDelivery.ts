import type { ReliableRunFrame } from '../shared/workerControl'

type DistributiveOmit<T, K extends PropertyKey> = T extends T ? Omit<T, K> : never

export type UnsequencedRunFrame = DistributiveOmit<ReliableRunFrame, 'sequence'>

/**
 * Per-run send callback used by `drain`.
 *
 * Contract: the promise must reject unless the frame was written to the current
 * socket. Resolving means "written on this connection", not "the server applied
 * it". A rejected send must not advance the sent cursor; a later `drain` retries
 * the same frame. Task 2 makes `sendWsJson` honor this.
 */
export type ReliableDeliverySend = (frame: ReliableRunFrame) => Promise<void>

export interface ReliableDeliveryQueue {
  enqueue(frame: UnsequencedRunFrame): ReliableRunFrame
  acknowledge(sequence: number): void
  /**
   * Apply a server resume cursor. Resolves `true` when the cursor was usable —
   * only then has the server actually adopted this run's delivery; a cursor
   * above the spool (or otherwise invalid) resolves `false` and changes nothing.
   */
  resumeAfter(sequence: number): Promise<boolean>
  drain(send: ReliableDeliverySend): Promise<void>
  /** Stop sending until a later resumeAfter applies a cursor for this connection. */
  holdSends(): void
  pending(): ReliableRunFrame[]
  readonly terminalAcknowledged: boolean
}

/**
 * Per-run ordered in-memory spool. Sequence numbers are allocated here exactly
 * once; a successful WebSocket write does not remove a frame — only ACK does.
 */
export function createReliableDeliveryQueue(): ReliableDeliveryQueue {
  const frames: ReliableRunFrame[] = []
  let nextSequence = 1
  let ackedThrough = 0
  /** Highest contiguous sequence whose send() resolved (written, not ACKed). */
  let sentThrough = 0
  let terminalSequence: number | null = null
  let terminalAcked = false
  let sendsHeld = false
  let chain: Promise<void> = Promise.resolve()

  const highestEnqueued = (): number => nextSequence - 1

  const enqueue = (frame: UnsequencedRunFrame): ReliableRunFrame => {
    const sequenced = { ...frame, sequence: nextSequence++ } as ReliableRunFrame
    frames.push(sequenced)
    if (sequenced.type === 'run:exit') terminalSequence = sequenced.sequence
    return sequenced
  }

  const acknowledge = (sequence: number): void => {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return
    if (sequence <= ackedThrough) return
    // Only sequences that have been written can be ACKed. A fabricated ACK for
    // an unsent or future frame must not discard spool contents.
    if (sequence > sentThrough) return
    ackedThrough = sequence
    while (frames.length > 0 && frames[0]!.sequence <= ackedThrough) {
      frames.shift()
    }
    if (terminalSequence !== null && ackedThrough >= terminalSequence) {
      terminalAcked = true
    }
  }

  const applyResume = (sequence: number): boolean => {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return false
    if (sequence > highestEnqueued()) return false
    sentThrough = sequence
    sendsHeld = false
    return true
  }

  const resumeAfter = (sequence: number): Promise<boolean> => {
    const applied = chain.then(
      () => applyResume(sequence),
      () => applyResume(sequence)
    )
    chain = applied.then(
      () => undefined,
      () => undefined
    )
    return applied
  }

  const drainOnce = async (send: ReliableDeliverySend): Promise<void> => {
    if (sendsHeld) return
    while (true) {
      if (sendsHeld) return
      const next = frames.find((frame) => frame.sequence > ackedThrough && frame.sequence > sentThrough)
      if (!next) return
      // sentThrough advances only after send resolves; a rejection retries this frame.
      await send(next)
      if (next.sequence === Math.max(ackedThrough, sentThrough) + 1) sentThrough = next.sequence
      if (sendsHeld) return
    }
  }

  const drain = (send: ReliableDeliverySend): Promise<void> => {
    chain = chain.then(
      () => drainOnce(send),
      () => drainOnce(send)
    )
    return chain
  }

  return {
    enqueue,
    acknowledge,
    resumeAfter,
    drain,
    holdSends: () => {
      sendsHeld = true
    },
    pending: () => frames.filter((frame) => frame.sequence > ackedThrough),
    get terminalAcknowledged() {
      return terminalAcked
    },
  }
}
