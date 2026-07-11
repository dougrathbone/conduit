import { describe, it, expect } from 'vitest'
import { describeToolUse, summarizeEvent, isRunEvent, runLogToText } from './runEvents'
import type { RunEvent, RunEventInit } from './types'

describe('describeToolUse', () => {
  const cases: Array<[string, string, unknown, { title: string; subtitle?: string }]> = [
    ['Bash → command', 'Bash', { command: 'npm run build' }, { title: 'Bash', subtitle: 'npm run build' }],
    ['Read → file_path', 'Read', { file_path: 'src/config.ts' }, { title: 'Read', subtitle: 'src/config.ts' }],
    ['Write → file_path', 'Write', { file_path: 'a.ts' }, { title: 'Write', subtitle: 'a.ts' }],
    ['Edit → file_path', 'Edit', { file_path: 'a.ts' }, { title: 'Edit', subtitle: 'a.ts' }],
    ['Glob → pattern', 'Glob', { pattern: '**/*.ts' }, { title: 'Glob', subtitle: '**/*.ts' }],
    ['Grep → pattern in path', 'Grep', { pattern: 'foo', path: 'src' }, { title: 'Grep', subtitle: 'foo in src' }],
    ['Grep → pattern only', 'Grep', { pattern: 'foo' }, { title: 'Grep', subtitle: 'foo' }],
    ['Agent → description', 'Agent', { description: 'find bugs', prompt: 'long...' }, { title: 'Agent', subtitle: 'find bugs' }],
    ['MCP → server/tool', 'mcp__linear__create_issue', {}, { title: 'linear', subtitle: 'create_issue' }],
    ['TodoWrite → bare', 'TodoWrite', { todos: [] }, { title: 'TodoWrite' }],
    ['unknown tool → bare name', 'SomethingNew', { x: 1 }, { title: 'SomethingNew' }],
  ]

  it.each(cases)('%s', (_label, name, input, expected) => {
    expect(describeToolUse(name, input)).toEqual(expected)
  })

  it('handles missing/undefined input', () => {
    expect(describeToolUse('Read', undefined)).toEqual({ title: 'Read', subtitle: undefined })
    expect(describeToolUse(undefined, undefined)).toEqual({ title: 'tool' })
  })

  it('truncates very long Bash commands', () => {
    const cmd = 'x'.repeat(500)
    const d = describeToolUse('Bash', { command: cmd })
    expect(d.subtitle!.length).toBeLessThanOrEqual(201)
    expect(d.subtitle!.endsWith('…')).toBe(true)
  })
})

describe('summarizeEvent', () => {
  const mk = (e: RunEventInit): RunEventInit => e

  it('summarizes assistant text as its first non-empty line', () => {
    expect(summarizeEvent(mk({ kind: 'assistant', text: '\n\nHello there\nsecond line' }))).toBe('Hello there')
  })

  it('summarizes a tool_use as title + subtitle', () => {
    expect(summarizeEvent(mk({ kind: 'tool_use', toolName: 'Edit', toolInput: { file_path: 'a.ts' } }))).toBe('Edit a.ts')
  })

  it('summarizes a bare tool_use as just the title', () => {
    expect(summarizeEvent(mk({ kind: 'tool_use', toolName: 'TodoWrite', toolInput: {} }))).toBe('TodoWrite')
  })

  it('returns empty for tool_result and result (not activity)', () => {
    expect(summarizeEvent(mk({ kind: 'tool_result', content: 'out' }))).toBe('')
    expect(summarizeEvent(mk({ kind: 'result', isError: false }))).toBe('')
  })

  it('summarizes raw text', () => {
    expect(summarizeEvent(mk({ kind: 'raw', stream: 'stderr', text: 'boom' }))).toBe('boom')
    expect(summarizeEvent(mk({ kind: 'raw', stream: 'system', text: '   ' }))).toBe('')
  })
})

describe('runLogToText', () => {
  it('renders assistant text, a tool call with its paired output, and the result', () => {
    const events: RunEvent[] = [
      { t: 1, kind: 'assistant', text: 'Let me check the build.' },
      { t: 2, kind: 'tool_use', toolUseId: 'a', toolName: 'Bash', toolInput: { command: 'npm run build' } },
      { t: 3, kind: 'tool_result', toolUseId: 'a', content: 'Build OK\nDone' },
      { t: 4, kind: 'result', isError: false },
    ]
    const text = runLogToText(events)
    expect(text).toContain('● Let me check the build.')
    expect(text).toContain('❯ Bash npm run build')
    expect(text).toContain('    Build OK')
    expect(text).toContain('    Done')
    expect(text).toContain('✓ Completed')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('pairs each output to its call by toolUseId, not by stream order', () => {
    const events: RunEvent[] = [
      { t: 1, kind: 'tool_use', toolUseId: 'x', toolName: 'Read', toolInput: { file_path: 'a.ts' } },
      { t: 2, kind: 'tool_use', toolUseId: 'y', toolName: 'Read', toolInput: { file_path: 'b.ts' } },
      { t: 3, kind: 'tool_result', toolUseId: 'y', content: 'contents of b' },
      { t: 4, kind: 'tool_result', toolUseId: 'x', content: 'contents of a' },
    ]
    const text = runLogToText(events)
    // Output for a.ts must sit under the a.ts call, before the b.ts call.
    expect(text.indexOf('contents of a')).toBeLessThan(text.indexOf('b.ts'))
    expect(text.indexOf('contents of b')).toBeGreaterThan(text.indexOf('b.ts'))
  })

  it('marks a failed result', () => {
    expect(runLogToText([{ t: 1, kind: 'result', isError: true }])).toContain('✗ Failed')
  })

  it('renders a tool call with no output as just its header', () => {
    const text = runLogToText([{ t: 1, kind: 'tool_use', toolName: 'TodoWrite', toolInput: {} }])
    expect(text.trim()).toBe('❯ TodoWrite')
  })
})

describe('isRunEvent', () => {
  it('accepts objects with a string kind', () => {
    expect(isRunEvent({ kind: 'assistant', t: 1 })).toBe(true)
  })
  it('rejects legacy log entries and junk', () => {
    expect(isRunEvent({ t: 1, stream: 'stdout', chunk: 'hi' })).toBe(false)
    expect(isRunEvent(null)).toBe(false)
    expect(isRunEvent('x')).toBe(false)
  })
})
