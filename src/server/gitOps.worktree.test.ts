import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Real-git integration: exercises removeWorktree against an actual repo + worktree
// so we verify true reclamation behaviour (the incident was worktrees that would
// not delete and whose failure was swallowed). No child_process mock here.
import { removeWorktree } from './gitOps'

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
