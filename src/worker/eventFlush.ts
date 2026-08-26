import type { RunEventInit } from '../shared/types'
import type { ReliableRunFrame, WorkerRunEventMessage } from '../shared/workerControl'
import { chunkRunEvents } from './eventBatch'
import type { ReliableDeliveryQueue } from './reliableDelivery'

export interface EventFlushQueue {
  push(ev: RunEventInit): void
  /** Drain the buffer after any in-flight send chain finishes. */
  flush(): Promise<void>
}

/**
 * Serializes run:event flushes so a second drain cannot interleave with an
 * in-flight chunk send, and so onExit can wait for trailing events.
 *
 * When a reliable delivery queue is provided, chunked batches are enqueued
 * there and retained until ACK — a successful WebSocket write is not delivery.
 */
export function createEventFlushQueue(opts: {
  runId: string
  send: (frame: WorkerRunEventMessage | ReliableRunFrame) => Promise<void>
  delivery?: Pick<ReliableDeliveryQueue, 'enqueue' | 'drain'>
}): EventFlushQueue {
  const buffer: RunEventInit[] = []
  let scheduled = false
  let chain: Promise<void> = Promise.resolve()

  const drain = async (): Promise<void> => {
    scheduled = false
    while (buffer.length > 0) {
      const events = buffer.splice(0)
      const frames = chunkRunEvents(opts.runId, events)
      if (opts.delivery) {
        for (const frame of frames) {
          opts.delivery.enqueue(frame)
        }
        try {
          await opts.delivery.drain((frame) => opts.send(frame))
        } catch {
          // Defer send failure; frames stay on the spool until resume/replay.
        }
      } else {
        try {
          for (const frame of frames) {
            await opts.send(frame)
          }
        } catch {
          buffer.unshift(...events)
          return
        }
      }
    }
  }

  const enqueueDrain = (): Promise<void> => {
    chain = chain.then(drain, drain)
    return chain
  }

  return {
    push(ev: RunEventInit): void {
      buffer.push(ev)
      if (!scheduled) {
        scheduled = true
        void enqueueDrain()
      }
    },
    flush(): Promise<void> {
      return enqueueDrain()
    },
  }
}
