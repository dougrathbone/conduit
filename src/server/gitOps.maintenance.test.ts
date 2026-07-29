import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Mock git: `worktree list --porcelain` and `count-objects -v` return canned
// stdout; `gc` can be made to fail via gcFailure; everything else exits 0.
// Lets us test the parsing helpers without git.
const spawnCalls: string[][] = []
let worktreeListStdout = ''
let countObjectsStdout = ''
let gcFailure: { code: number; stderr: string } | null = null

vi.mock('child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[]) => {
    spawnCalls.push(args)
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        child.stdout.emit('data', Buffer.from(worktreeListStdout))
        child.emit('close', 0)
      } else if (args[0] === 'count-objects') {
        child.stdout.emit('data', Buffer.from(countObjectsStdout))
        child.emit('close', 0)
      } else if (args[0] === 'gc' && gcFailure) {
        child.stderr.emit('data', Buffer.from(gcFailure.stderr))
        child.emit('close', gcFailure.code)
      } else {
        child.emit('close', 0)
      }
    })
    return child
  }),
}))

import { listWorktrees, getGcStats, gcBareClone } from './gitOps'

beforeEach(() => {
  spawnCalls.length = 0
  gcFailure = null
})

describe('gcBareClone', () => {
  it('runs git gc and removes stale tmp_pack garbage while sparing recent temps and real packs', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-'))
    const packDir = path.join(base, 'objects', 'pack')
    fs.mkdirSync(packDir, { recursive: true })
    const stale = path.join(packDir, 'tmp_pack_stale') // crash leftover
    const fresh = path.join(packDir, 'tmp_pack_fresh') // a live op's temp
    const realPack = path.join(packDir, 'pack-abc123.pack')
    fs.writeFileSync(stale, 'x')
    fs.writeFileSync(fresh, 'x')
    fs.writeFileSync(realPack, 'x')
    // Age the stale temp well past the cleanup threshold.
    const threeHoursAgo = Date.now() / 1000 - 3 * 3600
    fs.utimesSync(stale, threeHoursAgo, threeHoursAgo)
    try {
      expect(await gcBareClone(base)).toBe(true) // gc ran
      expect(fs.existsSync(stale)).toBe(false) // removed — git gc leaves it, we don't
      expect(fs.existsSync(fresh)).toBe(true) // spared — could be an in-flight fetch's temp
      expect(fs.existsSync(realPack)).toBe(true) // never touched — not a tmp_ file
      expect(spawnCalls.some((a) => a[0] === 'gc')).toBe(true) // did run git gc
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('treats a "gc is already running" failure as a benign skip, not an error', async () => {
    // The exact failure git produces when another gc holds the gc.pid lock
    // (e.g. a previous sweep's gc still running, or git's own auto-gc).
    gcFailure = {
      code: 128,
      stderr: "fatal: gc is already running on machine 'pod-1a2b3c' pid 68 (use --force if not)",
    }
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-'))
    try {
      await expect(gcBareClone(base)).resolves.toBe(false) // skipped, never throws
      expect(spawnCalls.some((a) => a[0] === 'gc')).toBe(true) // gc was attempted
      expect(spawnCalls.some((a) => a.includes('--force'))).toBe(false) // never forced
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('skips gc without spawning git when a gc.pid lock file exists', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-'))
    fs.writeFileSync(path.join(base, 'gc.pid'), '68 pod-1a2b3c\n')
    try {
      await expect(gcBareClone(base)).resolves.toBe(false)
      expect(spawnCalls.some((a) => a[0] === 'gc')).toBe(false) // didn't even try
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('still throws a genuine gc failure so the caller can report it', async () => {
    gcFailure = { code: 128, stderr: 'fatal: unable to read abc123: corrupt object' }
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-'))
    try {
      await expect(gcBareClone(base)).rejects.toThrow('corrupt object')
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('listWorktrees', () => {
  it('returns every registered worktree checkout path except the bare root', async () => {
    const bare = '/data/repos/abc'
    worktreeListStdout = [
      `worktree ${bare}`,
      'bare',
      '',
      `worktree ${bare}/worktrees-run/run-1`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/run-1',
      '',
      `worktree ${bare}/.claude/worktrees/agent-xyz`,
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/dougrathbone/fix-thing',
      '',
    ].join('\n')

    const paths = await listWorktrees(bare)
    expect(paths).toEqual([
      `${bare}/worktrees-run/run-1`,
      `${bare}/.claude/worktrees/agent-xyz`,
    ])
    // It asked git, using the bare clone as cwd.
    expect(spawnCalls.some((a) => a[0] === 'worktree' && a[1] === 'list')).toBe(true)
  })
})

describe('getGcStats', () => {
  it('parses the pack count and detects leftover garbage', async () => {
    countObjectsStdout = [
      'count: 0',
      'size: 0',
      'in-pack: 3096224',
      'packs: 29',
      'size-pack: 19942',
      'prune-packable: 0',
      'garbage: 5',
      'size-garbage: 1127',
    ].join('\n')

    const stats = await getGcStats('/data/repos/abc')
    expect(stats.packs).toBe(29)
    expect(stats.hasGarbage).toBe(true)
  })

  it('reports no garbage and the pack count for a tidy repo', async () => {
    countObjectsStdout = ['count: 10', 'packs: 1', 'garbage: 0', 'size-garbage: 0'].join('\n')
    const stats = await getGcStats('/data/repos/abc')
    expect(stats.packs).toBe(1)
    expect(stats.hasGarbage).toBe(false)
  })
})
