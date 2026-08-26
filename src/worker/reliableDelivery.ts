import type { ReliableRunFrame } from '../shared/workerControl'

export type UnsequencedRunFrame = Omit<ReliableRunFrame, 'sequence'>

export interface ReliableDeliveryQueue {
  enqueue(frame: UnsequencedRunFrame): ReliableRunFrame
  acknowledge(sequence: number): void
  resumeAfter(sequence: number): void
  drain(send: (frame: ReliableRunFrame) => Promise<void>): Promise<void>
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
  let sentThrough = 0
  let terminalSequence: number | null = null
  let terminalAcked = false
  let chain: Promise<void> = Promise.resolve()

  const enqueue = (frame: UnsequencedRunFrame): ReliableRunFrame => {
    const sequenced = { ...frame, sequence: nextSequence++ } as ReliableRunFrame
    frames.push(sequenced)
    if (sequenced.type === 'run:exit') terminalSequence = sequenced.sequence
    return sequenced
  }

  const acknowledge = (sequence: number): void => {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return
    if (sequence <= ackedThrough) return
    const highestEnqueued = nextSequence - 1
    if (sequence > highestEnqueued) return
    ackedThrough = sequence
    while (frames.length > 0 && frames[0]!.sequence <= ackedThrough) {
      frames.shift()
    }
    if (terminalSequence !== null && ackedThrough >= terminalSequence) {
      terminalAcked = true
    }
  }

  const resumeAfter = (sequence: number): void => {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return
    sentThrough = sequence
  }

  const drainOnce = async (send: (frame: ReliableRunFrame) => Promise<void>): Promise<void> => {
    while (true) {
      const next = frames.find((frame) => frame.sequence > ackedThrough && frame.sequence > sentThrough)
      if (!next) return
      await send(next)
      if (next.sequence > sentThrough) sentThrough = next.sequence
    }
  }

  const drain = (send: (frame: ReliableRunFrame) => Promise<void>): Promise<void> => {
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
    pending: () => frames.filter((frame) => frame.sequence > ackedThrough),
    get terminalAcknowledged() {
      return terminalAcked
    },
  }
}
