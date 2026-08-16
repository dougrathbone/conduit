import type { RunEventInit } from '../shared/types'
import type { WorkerRunEventMessage } from '../shared/workerControl'
import { chunkRunEvents } from './eventBatch'

export interface EventFlushQueue {
  push(ev: RunEventInit): void
  /** Drain the buffer after any in-flight send chain finishes. */
  flush(): Promise<void>
}

/**
 * Serializes run:event flushes so a second drain cannot interleave with an
 * in-flight chunk send, and so onExit can wait for trailing events.
 */
export function createEventFlushQueue(opts: {
  runId: string
  send: (frame: WorkerRunEventMessage) => Promise<void>
}): EventFlushQueue {
  const buffer: RunEventInit[] = []
  let scheduled = false
  let chain: Promise<void> = Promise.resolve()

  const drain = async (): Promise<void> => {
    scheduled = false
    while (buffer.length > 0) {
      const events = buffer.splice(0)
      for (const frame of chunkRunEvents(opts.runId, events)) {
        await opts.send(frame)
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
