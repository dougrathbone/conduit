import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

// Record each git invocation (args + options) so we can assert createWorktree
// materializes LFS content after checkout. `lfs pull` is made to fail on demand
// to prove it's best-effort.
const spawnCalls: { args: string[]; opts: { cwd?: string } }[] = []
let lfsFails = false

vi.mock('child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[], opts: { cwd?: string } = {}) => {
    spawnCalls.push({ args, opts })
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      if (args[0] === 'lfs' && lfsFails) {
        child.stderr.emit('data', Buffer.from("git: 'lfs' is not a git command.\n"))
        child.emit('close', 1)
      } else {
        child.emit('close', 0)
      }
    })
    return child
  }),
}))

import { createWorktree } from './gitOps'

beforeEach(() => {
  spawnCalls.length = 0
  lfsFails = false
})

describe('createWorktree — git-LFS materialization', () => {
  it('fetches then checks out LFS content in the worktree after `git worktree add`', async () => {
    const wt = '/clone/worktrees-run/r1'
    await createWorktree('/clone', wt, 'main')
    const subs = spawnCalls.map((c) => c.args.join(' '))
    // `--detach` so concurrent runs on the same branch don't collide (git refuses
    // to check out a branch already checked out in another worktree).
    expect(subs).toContain('worktree add --detach /clone/worktrees-run/r1 main')
    // Proven sequence: fetch objects (--all ignores any FetchExclude), then check
    // them out over the pointer files. Both run inside the worktree.
    const fetch = spawnCalls.find((c) => c.args[0] === 'lfs' && c.args[1] === 'fetch')
    const checkout = spawnCalls.find((c) => c.args[0] === 'lfs' && c.args[1] === 'checkout')
    expect(fetch?.args).toContain('--all')
    expect(fetch?.opts.cwd).toBe(wt)
    expect(checkout?.opts.cwd).toBe(wt)
  })

  it('does not fail the worktree when git-lfs is unavailable (best-effort)', async () => {
    lfsFails = true
    await expect(createWorktree('/clone', '/clone/worktrees-run/r2', 'main')).resolves.toBeUndefined()
  })
})
