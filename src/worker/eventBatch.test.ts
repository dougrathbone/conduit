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

  it('never emits a single-event frame over the byte cap; splits text instead', () => {
    const cap = WORKER_MAX_MESSAGE_BYTES - WORKER_EVENT_FRAME_HEADROOM
    const text = 'x'.repeat(cap + 50_000)
    const frames = chunkRunEvents('run-1', [raw(text)])
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.flatMap((f) => f.events.map((e) => e.text)).join('')).toBe(text)
    for (const frame of frames) {
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(cap)
    }
  })

  it('replaces a non-text oversized event with a system marker under the cap', () => {
    const cap = 2_000
    const ev: RunEventInit = {
      kind: 'tool_use',
      toolName: 'Write',
      toolInput: { contents: 'y'.repeat(8_000) },
    }
    const frames = chunkRunEvents('run-1', [ev], { maxBytes: cap })
    expect(frames.length).toBeGreaterThanOrEqual(1)
    for (const frame of frames) {
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(cap)
    }
    const texts = frames.flatMap((f) => f.events.map((e) => e.text ?? ''))
    expect(texts.some((t) => t.includes('oversized'))).toBe(true)
  })
})
