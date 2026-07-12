import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Real-git integration: exercises removeWorktree against an actual repo + worktree
// so we verify true reclamation behaviour (the incident was worktrees that would
// not delete and whose failure was swallowed). No child_process mock here.
import { createWorktree, removeWorktree } from './gitOps'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()

function makeRepoWithWorktree(): { repo: string; worktreesDir: string; worktree: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-gitops-test-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'master')
  git(repo, 'config', 'user.email', 't@t.com')
  git(repo, 'config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'f.txt'), 'hi')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'init')
  const worktreesDir = path.join(repo, 'worktrees-run')
  fs.mkdirSync(worktreesDir)
  const worktree = path.join(worktreesDir, 'w1')
  git(repo, 'worktree', 'add', '--detach', worktree)
  const cleanup = () => {
    try { fs.chmodSync(worktreesDir, 0o755) } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true })
  }
  return { repo, worktreesDir, worktree, cleanup }
}

describe('removeWorktree', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { cleanups.splice(0).forEach((c) => c()) })

  it('removes the worktree directory and deregisters it from the repo', async () => {
    const { repo, worktree, cleanup } = makeRepoWithWorktree()
    cleanups.push(cleanup)

    await removeWorktree(repo, worktree)

    expect(fs.existsSync(worktree)).toBe(false)
    expect(git(repo, 'worktree', 'list')).not.toContain(worktree)
  })

  it('throws when the worktree cannot be removed (so the leak is never silent)', async () => {
    const { repo, worktreesDir, worktree, cleanup } = makeRepoWithWorktree()
    cleanups.push(cleanup)

    // Read-only parent dir → the child worktree cannot be unlinked (models the
    // EACCES / undeletable-content case seen in prod). git remove AND fs.rmSync
    // both fail; the directory survives.
    fs.chmodSync(worktreesDir, 0o555)

    await expect(removeWorktree(repo, worktree)).rejects.toThrow()
    expect(fs.existsSync(worktree)).toBe(true) // still there — that's why it threw
  })
})

function makeCloneWithBranch(): { clone: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-gitops-conc-'))
  const clone = path.join(root, 'repo')
  fs.mkdirSync(clone)
  git(clone, 'init', '-b', 'master')
  git(clone, 'config', 'user.email', 't@t.com')
  git(clone, 'config', 'user.name', 'T')
  fs.writeFileSync(path.join(clone, 'f.txt'), 'hi')
  git(clone, 'add', '.')
  git(clone, 'commit', '-m', 'init')
  fs.mkdirSync(path.join(clone, 'worktrees-run'))
  return { clone, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

describe('createWorktree — concurrent runs on the same branch', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { cleanups.splice(0).forEach((c) => c()) })

  // Two runs of the same agent/repo overlap in time: both want a worktree at the
  // tip of `master`. Git refuses to check out a branch that is already checked out
  // in another worktree, so a name-based `worktree add <path> master` fails the
  // second run with `fatal: 'master' is already checked out at …`. Each run must
  // get its own isolated checkout of master's commit regardless of overlap.
  it('lets a second worktree be created while the first is still checked out', async () => {
    const { clone, cleanup } = makeCloneWithBranch()
    cleanups.push(cleanup)

    const wtA = path.join(clone, 'worktrees-run', 'run-a')
    const wtB = path.join(clone, 'worktrees-run', 'run-b')

    await createWorktree(clone, wtA, 'master')
    // The first worktree is intentionally left in place (an active run) when the
    // second is created — this is the concurrency the fix must support.
    await createWorktree(clone, wtB, 'master')

    // Both are real, independent checkouts at master's tip.
    expect(fs.readFileSync(path.join(wtA, 'f.txt'), 'utf8')).toBe('hi')
    expect(fs.readFileSync(path.join(wtB, 'f.txt'), 'utf8')).toBe('hi')
    const head = git(clone, 'rev-parse', 'master').trim()
    expect(git(wtA, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(wtB, 'rev-parse', 'HEAD').trim()).toBe(head)
  })
})
