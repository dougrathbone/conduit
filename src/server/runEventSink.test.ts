import { describe, it, expect } from 'vitest'
import type { RunEvent } from '../shared/types'
import { createRunEventHandlers } from './runEventSink'

describe('createRunEventHandlers', () => {
  it('writes to the log for onEvent but not for onDurableEvent, and still notifies live listeners once', () => {
    const written: string[] = []
    const live: string[] = []
    const handlers = createRunEventHandlers({
      write: (event: RunEvent) => written.push(event.text ?? ''),
      live: (event: RunEvent) => live.push(event.text ?? ''),
    })

    handlers.onEvent({ kind: 'raw', stream: 'stdout', text: 'legacy' })
    handlers.onDurableEvent({ kind: 'raw', stream: 'stdout', text: 'sequenced' })

    expect(written).toEqual(['legacy'])
    expect(live).toEqual(['legacy', 'sequenced'])
  })
})
