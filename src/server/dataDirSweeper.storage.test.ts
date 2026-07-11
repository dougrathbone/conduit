import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Mock the module's I/O-bearing graph imports so loading it is cheap and
// side-effect-free. `fs` is intentionally NOT mocked — these tests exercise the
// real filesystem against temp fixtures they create and tear down themselves.
vi.mock('./runner', () => ({
  getActiveWorkspacePaths: () => new Set<string>(),
  getActiveRunIds: () => new Set<string>(),
}))
vi.mock('./gitOps', () => ({ removeWorktree: vi.fn(async () => {}) }))
vi.mock('../main/execution/workspace', () => ({ deleteWorkspace: vi.fn(() => {}) }))
vi.mock('./observability', () => ({ reporter: { captureException: vi.fn() } }))
vi.mock('../main/utils/paths', () => ({
  REPOS_DIR: '/nonexistent-repos-for-test',
  DATA_DIR: '/nonexistent-data-for-test',
}))

import {
  dirSizeBytes,
  collectSweepCandidates,
  estimateStorageUsage,
  getStorageUsage,
  invalidateStorageUsageCache,
} from './dataDirSweeper'
import type { StorageUsage } from '../shared/types'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirsize-test-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const write = (rel: string, bytes: number) => {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, Buffer.alloc(bytes))
}

describe('dirSizeBytes', () => {
  it('returns 0 for a nonexistent path', async () => {
    expect(await dirSizeBytes(path.join(root, 'nope'))).toBe(0)
  })

  it('returns 0 for an empty directory', async () => {
    expect(await dirSizeBytes(root)).toBe(0)
  })

  it('sums file sizes at the top level', async () => {
    write('a.bin', 100)
    write('b.bin', 250)
    expect(await dirSizeBytes(root)).toBe(350)
  })

  it('sums nested file sizes recursively', async () => {
    write('a.bin', 100)
    write('sub/b.bin', 200)
    write('sub/deep/c.bin', 300)
    expect(await dirSizeBytes(root)).toBe(600)
  })

  it('does not follow symlinks (no double-count, no target inflation)', async () => {
    write('real.bin', 1000)
    const link = path.join(root, 'link.bin')
    try {
      fs.symlinkSync(path.join(root, 'real.bin'), link)
    } catch {
      return // symlinks unsupported on this platform — skip
    }
    // Only the real 1000-byte file counts; the symlink is ignored.
    expect(await dirSizeBytes(root)).toBe(1000)
  })
})

// UUIDs must match the strict 8-4-4-4-12 hex shape classifyTmpEntry expects.
const UUID_WS = '22222222-2222-4222-8222-222222222222' // stale workspace
const UUID_MCP = '33333333-3333-4333-8333-333333333333' // stale mcp config
const UUID_ACTIVE = '44444444-4444-4444-8444-444444444444' // active workspace (protected)
const UUID_WT = '55555555-5555-4555-8555-555555555555' // worktree

/**
 * Build a realistic on-disk layout:
 *   dataDir/conduit.db                                 (500)  db
 *   dataDir/logs/run.jsonl                             (300)  run history
 *   dataDir/repos/repo1/objects/pack.bin              (1000)  bare clone (kept)
 *   dataDir/repos/repo1/worktrees-run/<UUID_WT>/f.txt (2000)  worktree (reclaimable)
 *   tmpDir/conduit-<UUID_WS>-Ab3D9x/ws.txt             (400)  workspace (reclaimable)
 *   tmpDir/conduit-mcp-<UUID_MCP>.json                 (150)  mcp config (reclaimable)
 *   tmpDir/conduit-<UUID_ACTIVE>-Zz9Yy/ws.txt          (700)  workspace (ACTIVE → protected)
 */
function buildFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-data-'))
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-tmp-'))
  const reposDir = path.join(dataDir, 'repos')
  const put = (base: string, rel: string, bytes: number) => {
    const p = path.join(base, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, Buffer.alloc(bytes))
  }
  put(dataDir, 'conduit.db', 500)
  put(dataDir, 'logs/run.jsonl', 300)
  put(dataDir, 'repos/repo1/objects/pack.bin', 1000)
  put(dataDir, `repos/repo1/worktrees-run/${UUID_WT}/f.txt`, 2000)
  put(tmpDir, `conduit-${UUID_WS}-Ab3D9x/ws.txt`, 400)
  put(tmpDir, `conduit-mcp-${UUID_MCP}.json`, 150)
  put(tmpDir, `conduit-${UUID_ACTIVE}-Zz9Yy/ws.txt`, 700)
  const activeWorkspacePath = path.join(tmpDir, `conduit-${UUID_ACTIVE}-Zz9Yy`)
  return { dataDir, tmpDir, reposDir, activeWorkspacePath }
}

describe('collectSweepCandidates', () => {
  let fx: ReturnType<typeof buildFixture>
  beforeEach(() => {
    fx = buildFixture()
  })
  afterEach(() => {
    fs.rmSync(fx.dataDir, { recursive: true, force: true })
    fs.rmSync(fx.tmpDir, { recursive: true, force: true })
  })

  it('discovers worktrees, workspaces, and mcp configs with their clone paths', () => {
    const c = collectSweepCandidates({
      reposDir: fx.reposDir,
      tmpDir: fx.tmpDir,
      activePaths: new Set(),
      activeRunIds: new Set(),
    })
    expect(c.worktrees.map((w) => path.basename(w.path))).toEqual([UUID_WT])
    expect(c.worktrees[0].clonePath).toBe(path.join(fx.reposDir, 'repo1'))
    expect(c.workspaces.map((w) => path.basename(w.path)).sort()).toEqual(
      [`conduit-${UUID_WS}-Ab3D9x`, `conduit-${UUID_ACTIVE}-Zz9Yy`].sort()
    )
    expect(c.mcpConfigs.map((m) => path.basename(m.path))).toEqual([`conduit-mcp-${UUID_MCP}.json`])
  })

  it('flags artifacts of live runs via the injected active sets', () => {
    const c = collectSweepCandidates({
      reposDir: fx.reposDir,
      tmpDir: fx.tmpDir,
      activePaths: new Set([fx.activeWorkspacePath]),
      activeRunIds: new Set(),
    })
    const active = c.workspaces.find((w) => w.path === fx.activeWorkspacePath)
    const idle = c.workspaces.find((w) => w.path !== fx.activeWorkspacePath)
    expect(active?.protectedByActive).toBe(true)
    expect(idle?.protectedByActive).toBe(false)
  })
})

describe('estimateStorageUsage', () => {
  let fx: ReturnType<typeof buildFixture>
  beforeEach(() => {
    fx = buildFixture()
  })
  afterEach(() => {
    fs.rmSync(fx.dataDir, { recursive: true, force: true })
    fs.rmSync(fx.tmpDir, { recursive: true, force: true })
  })

  const opts = () => ({
    now: 10 ** 15, // far future → every artifact is past the grace period
    dataDir: fx.dataDir,
    reposDir: fx.reposDir,
    tmpDir: fx.tmpDir,
    activePaths: new Set([fx.activeWorkspacePath]),
    activeRunIds: new Set<string>(),
    // Inject the accurate byte-exact walker so assertions are deterministic; the
    // production default (`du`) reports block-rounded disk usage.
    measureDir: dirSizeBytes,
  })

  it('totals the whole data dir plus all Conduit temp artifacts', async () => {
    // dataDir 500+300+1000+2000 = 3800; temp 400+150+700 = 1250
    const usage = await estimateStorageUsage(opts())
    expect(usage.totalBytes).toBe(3800 + 1250)
  })

  it('counts as reclaimable exactly what a sweep-now would free', async () => {
    // stale worktree 2000 + stale workspace 400 + stale mcp 150 + expired log 300
    // = 2850; the active 700-byte workspace is protected and excluded. (now is far
    // in the future, so the log is well past the retention window.)
    const usage = await estimateStorageUsage(opts())
    expect(usage.reclaimableBytes).toBe(2000 + 400 + 150 + 300)
  })

  it('does NOT count a recent log as reclaimable (within the retention window)', async () => {
    // now = the log's mtime + 10 min: past the 5-min artifact grace (so worktree,
    // workspace, mcp are reclaimable) but far short of the 14-day log retention —
    // so the log is excluded. Reclaimable = 2000 + 400 + 150 = 2550, no log.
    const logMtime = fs.statSync(path.join(fx.dataDir, 'logs', 'run.jsonl')).mtimeMs
    const usage = await estimateStorageUsage({ ...opts(), now: logMtime + 10 * 60 * 1000 })
    expect(usage.reclaimableBytes).toBe(2000 + 400 + 150)
  })

  it('reclaims an orphaned bare clone when its repo is gone', async () => {
    // repo1 is NOT in the known set → its whole bare clone (pack 1000 + worktree
    // 2000 = 3000) is reclaimable. The worktree is subsumed by the clone (not
    // double-counted), so: clone 3000 + workspace 400 + mcp 150 + log 300 = 3850.
    const usage = await estimateStorageUsage({ ...opts(), knownRepoIds: new Set<string>() })
    expect(usage.reclaimableBytes).toBe(3000 + 400 + 150 + 300)
  })

  it('does NOT reclaim a bare clone whose repo still exists', async () => {
    // repo1 is known → clone kept; only the worktree/workspace/mcp/log count.
    const usage = await estimateStorageUsage({ ...opts(), knownRepoIds: new Set(['repo1']) })
    expect(usage.reclaimableBytes).toBe(2000 + 400 + 150 + 300)
  })

  it('keeps reclaimable a subset of total', async () => {
    const usage = await estimateStorageUsage(opts())
    expect(usage.reclaimableBytes).toBeLessThanOrEqual(usage.totalBytes)
  })
})

describe('getStorageUsage (server-side cache)', () => {
  // The real walk is a ~15s `du` over the whole data dir, so the handler serves
  // a cached value and only recomputes past the TTL or after invalidation.
  beforeEach(() => invalidateStorageUsageCache())

  const counter = () => {
    let calls = 0
    const compute = async (): Promise<StorageUsage> => {
      calls++
      return { totalBytes: calls * 100, reclaimableBytes: calls }
    }
    return { compute, calls: () => calls }
  }

  it('computes once and serves the cached value within the TTL', async () => {
    const c = counter()
    const first = await getStorageUsage(1_000, c.compute)
    const second = await getStorageUsage(1_000 + 59_000, c.compute) // still inside 60s TTL
    expect(first).toEqual({ totalBytes: 100, reclaimableBytes: 1 })
    expect(second).toEqual(first)
    expect(c.calls()).toBe(1)
  })

  it('recomputes once the TTL has elapsed', async () => {
    const c = counter()
    await getStorageUsage(1_000, c.compute)
    await getStorageUsage(1_000 + 61_000, c.compute) // past the TTL
    expect(c.calls()).toBe(2)
  })

  it('recomputes after explicit invalidation (e.g. a sweep freed space)', async () => {
    const c = counter()
    await getStorageUsage(1_000, c.compute)
    invalidateStorageUsageCache()
    const after = await getStorageUsage(1_000, c.compute)
    expect(c.calls()).toBe(2)
    expect(after.totalBytes).toBe(200)
  })

  it('coalesces concurrent callers onto a single computation', async () => {
    const c = counter()
    const [a, b] = await Promise.all([
      getStorageUsage(1_000, c.compute),
      getStorageUsage(1_000, c.compute),
    ])
    expect(a).toEqual(b)
    expect(c.calls()).toBe(1)
  })
})
