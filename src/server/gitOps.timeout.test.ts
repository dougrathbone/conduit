import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// A fake git child that NEVER exits (models a `git` blocked on a lock or a
// credential prompt with no TTY). `kill` records that it was signalled and then
// ends the process, so runGit's timeout path can be observed end-to-end.
class HangingChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(_signal?: string): boolean {
    this.killed = true
    return true
  }
}

const children: HangingChild[] = []
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const child = new HangingChild()
    children.push(child)
    return child
  }),
}))

import { runGit } from './gitOps'

describe('runGit timeout', () => {
  beforeEach(() => {
    children.length = 0
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('kills a git process that never exits and rejects with a timeout error', async () => {
    const p = runGit(['worktree', 'remove', '/x'], { timeoutMs: 1000 })
    // Surface the rejection to the fake-timer scheduler without an unhandled reject.
    const settled = p.then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err })
    )

    await vi.advanceTimersByTimeAsync(1000)

    const outcome = await settled
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.err.message).toMatch(/timed out/i)
    expect(children[0].killed).toBe(true)
  })
})
