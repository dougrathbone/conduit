import { describe, it, expect } from 'vitest'
import type { RunEventInit } from '../shared/types'
import { createEventFlushQueue } from './eventFlush'
import { createReliableDeliveryQueue } from './reliableDelivery'
import { recordLocalExit, replayFromCursor } from './reconnectPolicy'

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

  it('push with a rejecting send does not unhandled-reject, and local exit still enqueues after events for later resume', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const delivery = createReliableDeliveryQueue()
      const events = createEventFlushQueue({
        runId: 'run-1',
        delivery,
        send: async () => {
          throw new Error('WebSocket is not open')
        },
      })
      delivery.enqueue({ type: 'run:started', runId: 'run-1' })
      events.push(raw('a'))
      await events.flush()
      events.push(raw('b'))
      await events.flush()
      expect(unhandled).toEqual([])

      await recordLocalExit(events, delivery, {
        type: 'run:exit',
        runId: 'run-1',
        status: 'completed',
        exitCode: 0,
      })
      expect(delivery.pending().map((frame) => frame.type)).toEqual([
        'run:started',
        'run:event',
        'run:event',
        'run:exit',
      ])

      const sent: string[] = []
      await replayFromCursor(delivery, 0, async (frame) => {
        if (frame.type === 'run:event') sent.push(frame.events[0]?.text ?? '')
        else sent.push(frame.type)
      })
      expect(sent).toEqual(['run:started', 'a', 'b', 'run:exit'])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
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
