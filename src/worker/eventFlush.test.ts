import { describe, it, expect } from 'vitest'
import type { RunEventInit } from '../shared/types'
import type { WorkerRunEventMessage } from '../shared/workerControl'
import { createEventFlushQueue } from './eventFlush'

function raw(text: string): RunEventInit {
  return { kind: 'raw', stream: 'stdout', text }
}

describe('createEventFlushQueue', () => {
  it('serializes flushes so onExit waits for in-flight chunks and does not reorder', async () => {
    const sent: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let first = true
    const queue = createEventFlushQueue({
      runId: 'run-1',
      send: async (frame: WorkerRunEventMessage) => {
        sent.push(...frame.events.map((e) => e.text ?? ''))
        if (first) {
          first = false
          await gate
        }
      },
    })

    queue.push(raw('a'))
    await viWaitFor(() => sent.length === 1)
    queue.push(raw('b'))
    const flushed = queue.flush()
    expect(sent).toEqual(['a'])
    release()
    await flushed
    expect(sent).toEqual(['a', 'b'])
  })
})

function viWaitFor(pred: () => boolean, ms = 200): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (pred()) {
        resolve()
        return
      }
      if (Date.now() - start > ms) {
        reject(new Error('waitFor timed out'))
        return
      }
      setTimeout(tick, 5)
    }
    tick()
  })
}
