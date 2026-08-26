import { describe, it, expect } from 'vitest'
import type { RunEventInit } from '../shared/types'
import { createEventFlushQueue } from './eventFlush'
import { createReliableDeliveryQueue } from './reliableDelivery'

function raw(text: string): RunEventInit {
  return { kind: 'raw', stream: 'stdout', text }
}

describe('createEventFlushQueue', () => {
  it('enqueues chunked batches onto the reliable spool so a socket write is not treated as delivery', async () => {
    const delivery = createReliableDeliveryQueue()
    const written: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let first = true
    const queue = createEventFlushQueue({
      runId: 'run-1',
      delivery,
      send: async (frame) => {
        written.push(...frame.events.map((e) => e.text ?? ''))
        if (first) {
          first = false
          await gate
        }
      },
    })

    queue.push(raw('a'))
    await viWaitFor(() => written.length === 1)
    queue.push(raw('b'))
    const flushed = queue.flush()
    expect(written).toEqual(['a'])
    expect(delivery.pending().map((frame) => frame.sequence)).toEqual([1])
    release()
    await flushed
    expect(written).toEqual(['a', 'b'])
    expect(delivery.pending().map((frame) => frame.sequence)).toEqual([1, 2])
    delivery.acknowledge(1)
    expect(delivery.pending().map((frame) => frame.sequence)).toEqual([2])
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
