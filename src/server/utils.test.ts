import { describe, it, expect } from 'vitest'
import { runLogFromRows } from './utils'

describe('runLogFromRows', () => {
  it('treats an empty log as an empty events log', () => {
    expect(runLogFromRows([])).toEqual({ format: 'events', events: [] })
  })

  it('detects the structured events format by the `kind` discriminant', () => {
    const rows = [
      { t: 1, kind: 'assistant', text: 'hi' },
      { t: 2, kind: 'tool_use', toolName: 'Read', toolInput: { file_path: 'a.ts' } },
    ]
    const log = runLogFromRows(rows)
    expect(log.format).toBe('events')
    if (log.format === 'events') expect(log.events).toHaveLength(2)
  })

  it('detects the legacy terminal format by the `chunk` field', () => {
    const rows = [
      { t: 1, stream: 'stdout', chunk: 'hello\r\n' },
      { t: 2, stream: 'system', chunk: 'done' },
    ]
    const log = runLogFromRows(rows)
    expect(log.format).toBe('terminal')
    if (log.format === 'terminal') expect(log.entries).toHaveLength(2)
  })

  it('drops rows that match neither shape', () => {
    const log = runLogFromRows([
      { t: 1, kind: 'assistant', text: 'ok' },
      { garbage: true },
      42,
    ])
    expect(log.format).toBe('events')
    if (log.format === 'events') expect(log.events).toHaveLength(1)
  })
})
