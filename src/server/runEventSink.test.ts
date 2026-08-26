import { describe, it, expect } from 'vitest'
import type { RunEvent } from '../shared/types'
import { createRunEventHandlers } from './runEventSink'

function harness() {
  const persisted: string[] = []
  const forwarded: string[] = []
  const live: string[] = []
  const handlers = createRunEventHandlers({
    persist: (event: RunEvent) => persisted.push(event.text ?? ''),
    forward: (event: RunEvent) => forwarded.push(event.text ?? ''),
    live: (event: RunEvent) => live.push(event.text ?? ''),
  })
  return { persisted, forwarded, live, handlers }
}

describe('createRunEventHandlers', () => {
  it('persists, forwards, and observes a locally streamed event exactly once each', () => {
    const { persisted, forwarded, live, handlers } = harness()

    handlers.onEvent({ kind: 'raw', stream: 'stdout', text: 'legacy' })

    expect(persisted).toEqual(['legacy'])
    expect(forwarded).toEqual(['legacy'])
    expect(live).toEqual(['legacy'])
  })

  it('forwards an already-persisted event to the platform log without a second jsonl write', () => {
    const { persisted, forwarded, live, handlers } = harness()

    handlers.onDurableEvent({ kind: 'raw', stream: 'stdout', text: 'sequenced' })

    expect(persisted).toEqual([])
    expect(forwarded).toEqual(['sequenced'])
    expect(live).toEqual(['sequenced'])
  })

  it('stamps both paths so forwarded and live observers see the same event object', () => {
    const seen: RunEvent[] = []
    const handlers = createRunEventHandlers({
      persist: () => {},
      forward: (event) => seen.push(event),
      live: (event) => seen.push(event),
    })

    handlers.onDurableEvent({ kind: 'raw', stream: 'stdout', text: 'same' })

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
    expect(typeof seen[0]!.t).toBe('number')
  })
})
