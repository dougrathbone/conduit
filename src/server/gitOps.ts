import { spawn } from 'child_process'
import * as fs from 'fs'

/**
 * Redact any credentials embedded in a URL's userinfo (e.g.
 * `https://x-access-token:<token>@github.com/...`) before the string is logged,
 * stored as syncError, or broadcast to clients. git echoes the remote URL in
 * several failure modes, which would otherwise leak the PAT / installation token.
 */
export function redactCredentials(s: string): string {
  return s.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@')
}

/**
 * Run a git command and return a promise that resolves on success
 * or rejects with stderr on failure.
 */
/**
 * Default wall-clock bound for a git invocation. A git process can hang forever
 * — blocked on a `.git` lock left by a crashed process, or (with no TTY) on a
 * credential prompt — and without a bound that hang propagates: a stuck
 * `git worktree remove` inside the data-dir sweep never resolves, and because
 * the sweep coalesces on one in-flight promise it silently disables ALL cleanup
 * (periodic, post-run, and the manual "Clean up now" button). Every git call
 * therefore runs under a timeout that SIGKILLs the child and rejects. The
 * default is generous enough for a large clone/fetch; callers whose op should be
 * fast (worktree remove/prune) pass a shorter `timeoutMs`.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 10 * 60 * 1000 // 10 min

export function runGit(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // SIGKILL (not SIGTERM): a git process wedged on a lock may ignore TERM.
      child.kill('SIGKILL')
      reject(new Error(redactCredentials(`git ${args[0]} timed out after ${timeoutMs}ms`)))
    }, timeoutMs)
    // Don't let a pending git timeout keep the event loop (or a test) alive.
    if (typeof timer.unref === 'function') timer.unref()

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        reject(new Error(redactCredentials(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`)))
      }
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Failed to spawn git: ${err.message}`))
    })
  })
}

/**
 * Inject a PAT into an HTTPS git URL for authentication.
 * Returns the URL unchanged if it's not HTTPS or no PAT is provided.
 */
export function buildAuthUrl(url: string, pat?: string): string {
  if (!pat || !url.startsWith('https://')) return url
  // Transform https://github.com/... → https://x-access-token:<pat>@github.com/...
  return url.replace('https://', `https://x-access-token:${pat}@`)
}

/**
 * Test connectivity to a remote repository via `git ls-remote`.
 * Returns the default branch ref on success, or throws on failure.
 */
export async function testRepoConnection(url: string, pat?: string): Promise<string> {
  const authUrl = buildAuthUrl(url, pat)
  const output = await runGit(['ls-remote', '--heads', authUrl])
  const refCount = output.split('\n').filter((l) => l.trim()).length
  return `Connected — ${refCount} branch${refCount !== 1 ? 'es' : ''} found`
}

/**
 * Clone a repository as a bare clone (no working tree).
 */
export async function cloneRepo(
  url: string,
  clonePath: string,
  branch: string,
  pat?: string
): Promise<void> {
  const authUrl = buildAuthUrl(url, pat)
  await runGit(['clone', '--bare', '--single-branch', '--branch', branch, authUrl, clonePath])
}

/**
 * Fetch latest changes into a bare clone.
 */
export async function fetchRepo(clonePath: string, url: string, pat?: string): Promise<void> {
  const authUrl = buildAuthUrl(url, pat)
  // Set the remote URL in case the PAT changed, then fetch
  await runGit(['remote', 'set-url', 'origin', authUrl], { cwd: clonePath })
  await runGit(['fetch', '--prune', 'origin'], { cwd: clonePath })
}

/** True when a git error indicates the filesystem is out of space (ENOSPC). */
export function isDiskFullError(message: string): boolean {
  return /no space left on device|\bENOSPC\b/i.test(message)
}

/**
 * Create a git worktree from a bare clone for an isolated run workspace.
 *
 * If `git worktree add` fails part-way — classically because it ran out of disk
 * while checking out a large working tree — it leaves BOTH a partial checkout
 * and a registered worktree entry behind. Left in place those leak disk and
 * accumulate across failed runs, accelerating exhaustion until every run fails.
 * So on any failure we tear the partial worktree down before rethrowing, and we
 * translate an out-of-space failure into an actionable message (the raw git
 * error is a multi-kilobyte "Updating files:" progress dump).
 */
export async function createWorktree(
  clonePath: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  try {
    await runGit(['worktree', 'add', worktreePath, branch], { cwd: clonePath })
  } catch (err) {
    await removeWorktree(clonePath, worktreePath).catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    if (isDiskFullError(message)) {
      throw new Error(
        'Not enough disk space to create a worktree for this repository. ' +
        'Free space on the Conduit server or increase its data volume, then retry.'
      )
    }
    throw err instanceof Error ? err : new Error(message)
  }
}

/**
 * Configure a run worktree so the agent can commit and push:
 * - sets the committer identity (author name/email)
 * - points `origin` at a tokenized URL so `git push` authenticates
 *
 * `token` should be a freshly-resolved repo credential; for SSH/none repos pass
 * no token and the existing origin (SSH or plain) is left untouched.
 */
export async function configureWorktreeGit(
  worktreePath: string,
  opts: { url: string; token?: string; authorName: string; authorEmail: string }
): Promise<void> {
  await runGit(['config', 'user.name', opts.authorName], { cwd: worktreePath })
  await runGit(['config', 'user.email', opts.authorEmail], { cwd: worktreePath })
  if (opts.token && opts.url.startsWith('https://')) {
    await runGit(['remote', 'set-url', 'origin', buildAuthUrl(opts.url, opts.token)], { cwd: worktreePath })
  }
}

/** Worktree remove/prune should be quick; bound them well under the default so a
 *  lock-wedged git can't stall a sweep for 10 minutes per leaked worktree. */
const WORKTREE_GIT_TIMEOUT_MS = 2 * 60 * 1000 // 2 min

/**
 * Remove a git worktree and guarantee the space is reclaimed — or throw.
 *
 * A worktree checkout of a large monorepo is gigabytes and ~30k files; leaving
 * one behind leaks disk. The prior version swallowed every failure, so when a
 * removal failed (a lock-wedged `git worktree remove` that hung with no timeout,
 * or an `fs.rmSync` that errored) the worktree silently persisted and the data
 * dir filled until runs crashed. Now: try git's own removal (deregisters the
 * admin entry cleanly), then force-delete the directory regardless, then prune
 * stale refs — all bounded by a timeout so nothing can hang. If the directory
 * still exists afterwards the space was NOT reclaimed; we throw so the caller
 * (the sweeper / per-run cleanup) reports it instead of leaking in silence.
 */
export async function removeWorktree(clonePath: string, worktreePath: string): Promise<void> {
  // 1. Prefer git's own removal — it also deregisters the worktree admin entry,
  //    so a later `git worktree add <branch>` won't hit "already checked out".
  await runGit(['worktree', 'remove', '--force', worktreePath], {
    cwd: clonePath,
    timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
  }).catch(() => {
    /* fall through to a direct filesystem removal */
  })

  // 2. Whatever git did, make sure the directory is actually gone.
  if (fs.existsSync(worktreePath)) {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch {
      // Reported via the survival check below.
    }
  }

  // 3. Drop any stale admin ref a direct removal would leave behind (best-effort).
  await runGit(['worktree', 'prune'], { cwd: clonePath, timeoutMs: WORKTREE_GIT_TIMEOUT_MS }).catch(
    () => {}
  )

  // 4. Still present ⇒ space not reclaimed. Surface it — silent failure here is
  //    exactly how the volume filled.
  if (fs.existsSync(worktreePath)) {
    throw new Error(
      `Failed to remove worktree ${worktreePath}: directory still present after git and filesystem removal`
    )
  }
}
