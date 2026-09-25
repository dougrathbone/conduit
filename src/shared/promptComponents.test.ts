import { describe, expect, it } from 'vitest'
import {
  applyGlobalPromptComponents,
  normalizeWorkspaceRelativePath,
  validatePromptComponentInput,
  workspaceFilesFromComponents,
} from './promptComponents'

describe('normalizeWorkspaceRelativePath', () => {
  it('normalizes dots and backslashes', () => {
    expect(normalizeWorkspaceRelativePath(' .cursor/rules/foo.mdc ')).toBe('.cursor/rules/foo.mdc')
    expect(normalizeWorkspaceRelativePath('docs\\guide.md')).toBe('docs/guide.md')
    expect(normalizeWorkspaceRelativePath('./AGENTS.md')).toBe('AGENTS.md')
  })

  it('rejects traversal and absolute paths', () => {
    expect(() => normalizeWorkspaceRelativePath('../secret')).toThrow(/"\.\."/)
    expect(() => normalizeWorkspaceRelativePath('/etc/passwd')).toThrow(/relative/)
    expect(() => normalizeWorkspaceRelativePath('C:\\Windows')).toThrow(/relative/)
    expect(() => normalizeWorkspaceRelativePath('')).toThrow(/required/)
  })
})

describe('validatePromptComponentInput', () => {
  it('requires a name and a file path for file kind', () => {
    expect(() => validatePromptComponentInput({ name: '  ', kind: 'instruction' })).toThrow(/Name/)
    expect(() => validatePromptComponentInput({ name: 'x', kind: 'other' })).toThrow(/Kind/)
    expect(() => validatePromptComponentInput({ name: 'x', kind: 'file' })).toThrow(/required/)
    expect(validatePromptComponentInput({ name: 'Rules', kind: 'file', filePath: 'CLAUDE.md' })).toEqual({
      kind: 'file',
      filePath: 'CLAUDE.md',
    })
    expect(validatePromptComponentInput({ name: 'Tone', kind: 'instruction' })).toEqual({
      kind: 'instruction',
    })
  })
})

describe('applyGlobalPromptComponents', () => {
  it('returns the agent prompt unchanged when nothing is enabled', () => {
    expect(applyGlobalPromptComponents('do the thing', [])).toBe('do the thing')
    expect(
      applyGlobalPromptComponents('do the thing', [
        { name: 'off', kind: 'instruction', content: 'nope', enabled: false },
        { name: 'empty', kind: 'instruction', content: '  ', enabled: true },
      ])
    ).toBe('do the thing')
  })

  it('prepends instructions then inlines files, oldest first', () => {
    const withDates = [
      { name: 'Later', kind: 'instruction' as const, content: 'later', enabled: true, createdAt: 20 },
      { name: 'First', kind: 'instruction' as const, content: 'first', enabled: true, createdAt: 10 },
      {
        name: 'House style',
        kind: 'file' as const,
        content: 'use tabs',
        filePath: 'STYLE.md',
        enabled: true,
        createdAt: 15,
      },
    ]
    const out = applyGlobalPromptComponents('agent task', withDates)
    expect(out).toContain('# Conduit-wide instructions')
    expect(out.indexOf('## First')).toBeLessThan(out.indexOf('## Later'))
    expect(out).toContain('### `STYLE.md` (House style)')
    expect(out).toContain('use tabs')
    expect(out.endsWith('agent task')).toBe(true)
    expect(out).toContain('\n---\n')
  })
})

describe('workspaceFilesFromComponents', () => {
  it('returns only enabled files, oldest first', () => {
    expect(
      workspaceFilesFromComponents([
        { name: 'B', kind: 'file', content: 'b', filePath: 'b.md', enabled: true, createdAt: 2 },
        { name: 'A', kind: 'file', content: 'a', filePath: 'a.md', enabled: true, createdAt: 1 },
        { name: 'Off', kind: 'file', content: 'x', filePath: 'x.md', enabled: false, createdAt: 0 },
        { name: 'Instr', kind: 'instruction', content: 'i', enabled: true, createdAt: 0 },
      ])
    ).toEqual([
      { path: 'a.md', content: 'a', name: 'A' },
      { path: 'b.md', content: 'b', name: 'B' },
    ])
  })
})
