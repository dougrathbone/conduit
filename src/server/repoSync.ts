import * as fs from 'fs'
import { listRepositories, getRepository, updateRepository } from '../main/db/queries/repositories'
import { cloneRepo, fetchRepo } from './gitOps'
import { resolveRepoToken } from './githubApp'
import { DEV_CONTEXT } from './auth/config'
import { reporter } from './observability'
import type { BroadcastFn } from './runner'
import type { RepoSyncStatus } from '../shared/types'

const SYNC_BACKOFF_BASE_MS = 10 * 60 * 1000 // 10 min
const SYNC_BACKOFF_MAX_MS = 4 * 60 * 60 * 1000 // 4 h

/** Per-repo consecutive-failure state driving the retry backoff. */
export interface SyncFailureState {
  count: number
  /** Epoch ms before which this repo should not be retried. */
  nextAttemptAt: number
}

/** Exponential backoff delay for the Nth consecutive sync failure (base 10 min,
 *  doubling, capped at 4 h). Prevents a repo that can't clone/fetch — typically
 *  bad credentials — from being retried every 5-min cycle forever. */
export function computeSyncBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures)
  return Math.min(SYNC_BACKOFF_BASE_MS * 2 ** (n - 1), SYNC_BACKOFF_MAX_MS)
}

/** Advance the failure streak, computing when the repo may next be attempted. */
export function nextSyncBackoff(prev: SyncFailureState | undefined, now: number): SyncFailureState {
  const count = (prev?.count ?? 0) + 1
  return { count, nextAttemptAt: now + computeSyncBackoffMs(count) }
}

/** True while a repo is still inside its backoff window and must be skipped. */
export function isInSyncBackoff(state: SyncFailureState | undefined, now: number): boolean {
  return state !== undefined && now < state.nextAttemptAt
}

/**
 * Background service that keeps repository clones up-to-date.
 */
export class RepoSyncService {
  private intervalId: NodeJS.Timeout | null = null
  private syncInProgress = new Set<string>()
  /** Consecutive-failure backoff, keyed by repoId. Cleared on success or a
   *  manual retry (triggerSync). */
  private failures = new Map<string, SyncFailureState>()
  private broadcast: BroadcastFn

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast
  }

  start(intervalMs: number = 5 * 60 * 1000): void {
    // Stale-worktree cleanup is owned by DataDirSweeper (startup + periodic +
    // post-run + manual); RepoSyncService only keeps the bare clones in sync.
    this.syncAll().catch((err) => console.error('[repoSync] Initial sync failed:', err))
    this.intervalId = setInterval(() => {
      this.syncAll().catch((err) => console.error('[repoSync] Periodic sync failed:', err))
    }, intervalMs)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  async syncAll(): Promise<void> {
    const repos = await listRepositories(DEV_CONTEXT.userId, DEV_CONTEXT.userGroupIds)
    for (const repo of repos) {
      this.syncRepo(repo.id).catch((err) =>
        console.error(`[repoSync] Unexpected error syncing repo ${repo.id}:`, err)
      )
    }
  }

  async triggerSync(repoId: string): Promise<void> {
    // A manual retry is an explicit "try now" — clear any backoff so a repo the
    // user just fixed (e.g. corrected credentials) syncs immediately.
    this.failures.delete(repoId)
    await this.syncRepo(repoId)
  }

  async syncRepo(repoId: string): Promise<void> {
    if (this.syncInProgress.has(repoId)) return
    this.syncInProgress.add(repoId)

    try {
      const repo = await getRepository(repoId)
      if (!repo || !repo.clonePath) return

      // A repo that keeps failing (bad credentials, unreachable remote) must not
      // be retried every 5-min cycle — that hammered GitHub and flooded Sentry
      // with 284 identical clone failures/day. Skip until its backoff elapses.
      if (isInSyncBackoff(this.failures.get(repoId), Date.now())) return

      // Credential resolution can throw (e.g. GitHub App misconfigured). Treat it
      // as a sync failure so it also backs off, rather than escaping to syncAll.
      let token: string | undefined
      try {
        token = await resolveRepoToken(repo)
      } catch (err) {
        await this.recordSyncFailure(repoId, err, 'auth')
        return
      }

      const needsClone = repo.syncStatus === 'pending' || !fs.existsSync(repo.clonePath)

      if (needsClone) {
        await this.updateStatus(repoId, 'cloning')
        try {
          await cloneRepo(repo.url, repo.clonePath, repo.defaultBranch, token)
          await this.recordSyncSuccess(repoId)
        } catch (err) {
          await this.recordSyncFailure(repoId, err, 'clone')
        }
      } else {
        // Repo exists on disk — do a fetch
        await this.updateStatus(repoId, 'syncing')
        try {
          await fetchRepo(repo.clonePath, repo.url, token)
          await this.recordSyncSuccess(repoId)
        } catch (err) {
          await this.recordSyncFailure(repoId, err, 'fetch')
        }
      }
    } finally {
      this.syncInProgress.delete(repoId)
    }
  }

  /** Clear the failure streak and mark the repo ready. */
  private async recordSyncSuccess(repoId: string): Promise<void> {
    this.failures.delete(repoId)
    await updateRepository(repoId, {
      syncStatus: 'ready',
      lastSyncedAt: Date.now(),
      syncError: undefined,
    })
    await this.broadcastStatus(repoId)
  }

  /**
   * Advance the backoff streak, persist the error, and report to Sentry ONLY on
   * the first failure of a streak — a persistently-broken repo then produces one
   * event, not one every cycle. The DB `syncError` still reflects each attempt.
   */
  private async recordSyncFailure(repoId: string, err: unknown, op: string): Promise<void> {
    const prev = this.failures.get(repoId)
    this.failures.set(repoId, nextSyncBackoff(prev, Date.now()))
    if (!prev) {
      reporter.captureException(err, { tags: { component: 'repoSync', repoId, op } })
    }
    const message = err instanceof Error ? err.message : String(err)
    await updateRepository(repoId, { syncStatus: 'error', syncError: message })
    await this.broadcastStatus(repoId)
  }

  /** Update the sync status in DB and broadcast to clients. */
  private async updateStatus(repoId: string, syncStatus: RepoSyncStatus): Promise<void> {
    await updateRepository(repoId, { syncStatus })
    await this.broadcastStatus(repoId)
  }

  /** Broadcast the current status of a repo to all WebSocket clients. */
  private async broadcastStatus(repoId: string): Promise<void> {
    const repo = await getRepository(repoId)
    if (!repo) return
    this.broadcast('repo:syncStatus', {
      repoId,
      syncStatus: repo.syncStatus,
      syncError: repo.syncError,
      lastSyncedAt: repo.lastSyncedAt,
    })
  }
}
