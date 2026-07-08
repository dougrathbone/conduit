import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

// Record every git invocation so we can assert cleanup was attempted. The fake
// child fails `git worktree add` with an out-of-disk stderr dump and succeeds
// any other subcommand (e.g. the `worktree remove` cleanup).
const spawnCalls: string[][] = []
vi.mock('child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[]) => {
    spawnCalls.push(args)
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        child.stderr.emit(
          'data',
          Buffer.from('Updating files:  67% (19493/29094)\nerror: unable to create file x: No space left on device\n')
        )
        child.emit('close', 128)
      } else {
        child.emit('close', 0)
      }
    })
    return child
  }),
}))

import { redactCredentials, buildAuthUrl, isDiskFullError, createWorktree } from './gitOps'

describe('redactCredentials', () => {
  it('redacts an embedded token in an https URL', () => {
    const url = buildAuthUrl('https://github.com/acme/widgets.git', 'ghs_secrettoken')
    expect(url).toContain('ghs_secrettoken')
    const redacted = redactCredentials(`git clone failed: ${url}`)
    expect(redacted).not.toContain('ghs_secrettoken')
    expect(redacted).toContain('https://***@github.com/acme/widgets.git')
  })

  it('leaves credential-free strings unchanged', () => {
    const msg = 'git fetch failed (exit 128): fatal: repository not found'
    expect(redactCredentials(msg)).toBe(msg)
  })
})

describe('isDiskFullError', () => {
  it('detects ENOSPC / no-space git failures', () => {
    expect(isDiskFullError('error: ... No space left on device')).toBe(true)
    expect(isDiskFullError('spawn git ENOSPC')).toBe(true)
  })
  it('is false for unrelated failures', () => {
    expect(isDiskFullError("fatal: 'master' is already checked out")).toBe(false)
    expect(isDiskFullError('fatal: repository not found')).toBe(false)
  })
})

describe('createWorktree', () => {
  beforeEach(() => { spawnCalls.length = 0 })

  it('tears down the partial worktree and reports out-of-space when the checkout runs out of disk', async () => {
    await expect(createWorktree('/clone', '/clone/worktrees-run/r1', 'master')).rejects.toThrow(/disk space/i)

    const subcommands = spawnCalls.map((a) => `${a[0]} ${a[1]}`)
    // It attempted the add, then attempted to remove the partial worktree it left behind.
    expect(subcommands).toContain('worktree add')
    expect(subcommands.some((s) => s === 'worktree remove' || s === 'worktree prune')).toBe(true)
  })
})
