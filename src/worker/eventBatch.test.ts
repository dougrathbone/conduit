import { describe, it, expect } from 'vitest'
import type { RunEventInit } from '../shared/types'
import { WORKER_MAX_EVENT_BATCH, WORKER_MAX_MESSAGE_BYTES } from '../shared/workerControl'
import { chunkRunEvents, WORKER_EVENT_FRAME_HEADROOM } from './eventBatch'

function raw(text: string): RunEventInit {
  return { kind: 'raw', stream: 'stdout', text }
}

describe('chunkRunEvents', () => {
  it('splits bursts larger than WORKER_MAX_EVENT_BATCH and preserves order', () => {
    const events = Array.from({ length: WORKER_MAX_EVENT_BATCH + 40 }, (_, i) => raw(`e${i}`))
    const frames = chunkRunEvents('run-1', events)
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.every((f) => f.events.length <= WORKER_MAX_EVENT_BATCH)).toBe(true)
    expect(frames.flatMap((f) => f.events.map((e) => e.text))).toEqual(events.map((e) => e.text))
  })

  it('splits when the encoded frame would exceed the server byte cap', () => {
    const bulky = raw('x'.repeat(200_000))
    const events = [bulky, bulky, bulky, bulky, bulky, bulky]
    const frames = chunkRunEvents('run-1', events)
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.flatMap((f) => f.events)).toHaveLength(events.length)
    const cap = WORKER_MAX_MESSAGE_BYTES - WORKER_EVENT_FRAME_HEADROOM
    for (const frame of frames) {
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(cap)
    }
  })
})
