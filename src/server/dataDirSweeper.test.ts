import { describe, it, expect, vi } from 'vitest'

// The functions under test are pure; mock the module's I/O-bearing imports so
// loading it can never touch the real filesystem or pull in the runner graph.
vi.mock('./runner', () => ({
  getActiveWorkspacePaths: () => new Set<string>(),
  getActiveRunIds: () => new Set<string>(),
}))
vi.mock('./gitOps', () => ({
  removeWorktree: vi.fn(async () => {}),
  getClonesInProgress: () => new Set<string>(),
  listWorktrees: async () => [],
  getGcStats: async () => ({ packs: 0, hasGarbage: false }),
  gcBareClone: vi.fn(async () => {}),
}))
vi.mock('../main/execution/workspace', () => ({ deleteWorkspace: vi.fn(() => {}) }))
vi.mock('./observability', () => ({ reporter: { captureException: vi.fn() } }))
vi.mock('../main/utils/paths', () => ({ REPOS_DIR: '/nonexistent-repos-for-test' }))

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  selectStale,
  classifyTmpEntry,
  collectSweepCandidates,
  runLogArtifactPaths,
  type SweepEntry,
} from './dataDirSweeper'

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

describe('collectSweepCandidates — orphaned `.cloning` clone temps', () => {
  it('discovers leftover .cloning temp dirs and protects those an in-flight clone owns', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeper-cloning-test-'))
    const reposDir = path.join(base, 'repos')
    const tmpDir = path.join(base, 'tmp')
    const logsDir = path.join(base, 'logs')
    fs.mkdirSync(reposDir)
    fs.mkdirSync(tmpDir)
    fs.mkdirSync(logsDir)
    try {
      // A completed bare clone (a real repo) — must NOT be picked up as a temp.
      fs.mkdirSync(path.join(reposDir, '11111111-2222-3333-4444-555555555555'))
      // Two interrupted clone temps: one orphaned by a crash, one owned by a
      // clone currently in flight (must be spared).
      const orphan = path.join(reposDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.cloning')
      const active = path.join(reposDir, 'ffffffff-0000-1111-2222-333333333333.cloning')
      fs.mkdirSync(orphan)
      fs.mkdirSync(active)

      const { cloningTmp } = await collectSweepCandidates({
        reposDir,
        tmpDir,
        logsDir,
        activePaths: new Set(),
        activeRunIds: new Set(),
        activeClonePaths: new Set([active]),
        listWorktrees: async () => [],
      })

      const byPath = new Map(cloningTmp.map((c) => [c.path, c]))
      expect(byPath.size).toBe(2)
      expect(byPath.get(orphan)?.protectedByActive).toBe(false)
      expect(byPath.get(active)?.protectedByActive).toBe(true)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('collectSweepCandidates — agent-created worktrees (git-discovered)', () => {
  it('finds worktrees outside worktrees-run/ and spares them while the clone has a live run', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeper-wt-test-'))
    const reposDir = path.join(base, 'repos')
    const clone = path.join(reposDir, 'repo-1')
    const runWt = path.join(clone, 'worktrees-run', 'run-1') // Conduit's own (fs-scanned)
    const agentWt = path.join(clone, '.claude', 'worktrees', 'agent-x') // git-discovered
    fs.mkdirSync(runWt, { recursive: true })
    fs.mkdirSync(agentWt, { recursive: true })
    const tmpDir = path.join(base, 'tmp')
    const logsDir = path.join(base, 'logs')
    fs.mkdirSync(tmpDir)
    fs.mkdirSync(logsDir)
    try {
      // Idle clone: both the run worktree and the agent worktree are orphans.
      const idle = await collectSweepCandidates({
        reposDir,
        tmpDir,
        logsDir,
        activePaths: new Set(),
        activeRunIds: new Set(),
        activeClonePaths: new Set(),
        listWorktrees: async () => [agentWt],
      })
      const idleByPath = new Map(idle.worktrees.map((w) => [w.path, w]))
      expect(idleByPath.has(runWt)).toBe(true) // via filesystem scan
      expect(idleByPath.has(agentWt)).toBe(true) // via git worktree list — the leak the sweeper missed
      expect(idleByPath.get(agentWt)?.protectedByActive).toBe(false)

      // A live run under the clone: the untracked agent worktree is spared.
      const busy = await collectSweepCandidates({
        reposDir,
        tmpDir,
        logsDir,
        activePaths: new Set([runWt]),
        activeRunIds: new Set(),
        activeClonePaths: new Set(),
        listWorktrees: async () => [agentWt],
      })
      const busyByPath = new Map(busy.worktrees.map((w) => [w.path, w]))
      expect(busyByPath.get(runWt)?.protectedByActive).toBe(true) // exact active-set match
      expect(busyByPath.get(agentWt)?.protectedByActive).toBe(true) // spared: clone has a live run
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('runLogArtifactPaths', () => {
  it('includes the delivery-cursor sidecar so a reclaimed log leaves nothing behind', () => {
    expect(runLogArtifactPaths('/data/logs/run-1.jsonl')).toEqual([
      '/data/logs/run-1.jsonl',
      '/data/logs/run-1.jsonl.cursor',
      '/data/logs/run-1.jsonl.cursor.tmp',
    ])
  })
})

describe('collectSweepCandidates — run logs', () => {
  it('treats only the jsonl as a candidate, never the sidecar as a run of its own', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeper-log-test-'))
    const reposDir = path.join(base, 'repos')
    const tmpDir = path.join(base, 'tmp')
    const logsDir = path.join(base, 'logs')
    for (const dir of [reposDir, tmpDir, logsDir]) fs.mkdirSync(dir)
    try {
      const logPath = path.join(logsDir, 'run-9.jsonl')
      fs.writeFileSync(logPath, '{}\n')
      fs.writeFileSync(`${logPath}.cursor`, '{"sequence":3,"capped":true}\n')

      const { logs } = await collectSweepCandidates({
        reposDir,
        tmpDir,
        logsDir,
        activePaths: new Set(),
        activeRunIds: new Set(),
        activeClonePaths: new Set(),
        listWorktrees: async () => [],
      })

      expect(logs.map((l) => l.path)).toEqual([logPath])
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})
