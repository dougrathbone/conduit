import { describe, it, expect, vi } from 'vitest'

// The functions under test are pure; mock the module's I/O-bearing imports so
// loading it can never touch the real filesystem or pull in the runner graph.
vi.mock('./runner', () => ({
  getActiveWorkspacePaths: () => new Set<string>(),
  getActiveRunIds: () => new Set<string>(),
}))
vi.mock('./gitOps', () => ({ removeWorktree: vi.fn(async () => {}) }))
vi.mock('../main/execution/workspace', () => ({ deleteWorkspace: vi.fn(() => {}) }))
vi.mock('./observability', () => ({ reporter: { captureException: vi.fn() } }))
vi.mock('../main/utils/paths', () => ({ REPOS_DIR: '/nonexistent-repos-for-test' }))

import { selectStale, classifyTmpEntry, type SweepEntry } from './dataDirSweeper'

const UUID = '11111111-2222-3333-4444-555555555555'

describe('selectStale', () => {
  const now = 1_000_000
  const graceMs = 5 * 60 * 1000

  const mk = (over: Partial<SweepEntry>): SweepEntry => ({
    key: 'k',
    mtimeMs: now - graceMs, // exactly at the grace boundary by default
    protectedByActive: false,
    ...over,
  })

  it('never selects an artifact belonging to a live run, however old', () => {
    const entry = mk({ key: 'active', protectedByActive: true, mtimeMs: 0 })
    expect(selectStale([entry], { now, graceMs })).toEqual([])
  })

  it('spares artifacts younger than the grace period (the startup race window)', () => {
    const entry = mk({ key: 'young', mtimeMs: now - (graceMs - 1) })
    expect(selectStale([entry], { now, graceMs })).toEqual([])
  })

  it('selects inactive artifacts at or past the grace boundary', () => {
    const atBoundary = mk({ key: 'at', mtimeMs: now - graceMs })
    const old = mk({ key: 'old', mtimeMs: 0 })
    expect(selectStale([atBoundary, old], { now, graceMs }).map((e) => e.key)).toEqual(['at', 'old'])
  })

  it('picks exactly the removable subset from a mixed set', () => {
    const entries = [
      mk({ key: 'active-old', protectedByActive: true, mtimeMs: 0 }),
      mk({ key: 'inactive-young', mtimeMs: now }),
      mk({ key: 'inactive-old', mtimeMs: 0 }),
    ]
    expect(selectStale(entries, { now, graceMs }).map((e) => e.key)).toEqual(['inactive-old'])
  })
})

describe('classifyTmpEntry', () => {
  it('recognises an ephemeral workspace dir and extracts the runId', () => {
    expect(classifyTmpEntry(`conduit-${UUID}-Ab3D9x`)).toEqual({ kind: 'workspace', runId: UUID })
  })

  it('recognises a per-run MCP config file and extracts the runId', () => {
    expect(classifyTmpEntry(`conduit-mcp-${UUID}.json`)).toEqual({ kind: 'mcpConfig', runId: UUID })
  })

  it('classifies an MCP config as mcpConfig, not workspace (prefix overlaps)', () => {
    // Both patterns start with "conduit-"; the config must win.
    expect(classifyTmpEntry(`conduit-mcp-${UUID}.json`).kind).toBe('mcpConfig')
  })

  it('ignores unrelated or malformed temp entries', () => {
    for (const name of [
      'tmp-12345',
      'conduit-not-a-uuid-xyz',
      `conduit-mcp-not-a-uuid.json`,
      `conduit-${UUID}.json`, // no mkdtemp suffix → not a workspace dir match
      'some-other-app-cache',
    ]) {
      expect(classifyTmpEntry(name).kind).toBe('other')
    }
  })
})
