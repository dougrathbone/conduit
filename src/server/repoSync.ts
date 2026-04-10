import * as fs from 'fs'
import * as path from 'path'
import { listRepositories, getRepository, updateRepository } from '../main/db/queries/repositories'
import { cloneRepo, fetchRepo, removeWorktree } from './gitOps'
import { getGithubPat } from './store'
import { DEV_CONTEXT } from './auth/config'
import type { BroadcastFn } from './runner'
import type { RepoSyncStatus } from '../shared/types'

/**
 * Background service that keeps repository clones up-to-date.
 * Runs periodic fetches and handles initial clones for new repos.
 */
export class RepoSyncService {
  private intervalId: NodeJS.Timeout | null = null
  private syncInProgress = new Set<string>()
  private broadcast: BroadcastFn

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast
  }

  /** Start the sync loop. Runs an initial sync immediately, then on interval. */
  start(intervalMs: number = 5 * 60 * 1000): void {
    this.cleanupStaleWorktrees()
    this.syncAll()
    this.intervalId = setInterval(() => this.syncAll(), intervalMs)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /** Sync all repositories. */
  async syncAll(): Promise<void> {
    const repos = listRepositories(DEV_CONTEXT.userId, DEV_CONTEXT.userGroupIds)
    for (const repo of repos) {
      // Fire-and-forget each repo sync so one failure doesn't block others
      this.syncRepo(repo.id).catch((err) =>
        console.error(`[repoSync] Unexpected error syncing repo ${repo.id}:`, err)
      )
    }
  }

  /** Manually trigger a sync for a single repo. */
  async triggerSync(repoId: string): Promise<void> {
    await this.syncRepo(repoId)
  }

  /** Sync a single repository (clone if pending, fetch if ready). */
  async syncRepo(repoId: string): Promise<void> {
    if (this.syncInProgress.has(repoId)) return
    this.syncInProgress.add(repoId)

    try {
      const repo = getRepository(repoId)
      if (!repo || !repo.clonePath) return

      const pat = repo.authMethod === 'pat' ? getGithubPat() : undefined

      const needsClone = repo.syncStatus === 'pending' || !fs.existsSync(repo.clonePath)

      if (needsClone) {
        this.updateStatus(repoId, 'cloning')
        try {
          await cloneRepo(repo.url, repo.clonePath, repo.defaultBranch, pat)
          updateRepository(repoId, {
            syncStatus: 'ready',
            lastSyncedAt: Date.now(),
            syncError: undefined,
          })
          this.broadcastStatus(repoId)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          updateRepository(repoId, { syncStatus: 'error', syncError: message })
          this.broadcastStatus(repoId)
        }
      } else {
        // Repo exists on disk — do a fetch
        this.updateStatus(repoId, 'syncing')
        try {
          await fetchRepo(repo.clonePath, repo.url, pat)
          updateRepository(repoId, {
            syncStatus: 'ready',
            lastSyncedAt: Date.now(),
            syncError: undefined,
          })
          this.broadcastStatus(repoId)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // Keep the repo usable — just mark the error but don't lose 'ready' state
          // if we had a successful clone before
          updateRepository(repoId, { syncStatus: 'error', syncError: message })
          this.broadcastStatus(repoId)
        }
      }
    } finally {
      this.syncInProgress.delete(repoId)
    }
  }

  /** Update the sync status in DB and broadcast to clients. */
  private updateStatus(repoId: string, syncStatus: RepoSyncStatus): void {
    updateRepository(repoId, { syncStatus })
    this.broadcastStatus(repoId)
  }

  /** Broadcast the current status of a repo to all WebSocket clients. */
  private broadcastStatus(repoId: string): void {
    const repo = getRepository(repoId)
    if (!repo) return
    this.broadcast('repo:syncStatus', {
      repoId,
      syncStatus: repo.syncStatus,
      syncError: repo.syncError,
      lastSyncedAt: repo.lastSyncedAt,
    })
  }

  /**
   * Clean up stale worktrees left over from crashed runs.
   * Scans each repo's worktrees-run/ directory and removes orphaned worktrees.
   */
  private cleanupStaleWorktrees(): void {
    const repos = listRepositories(DEV_CONTEXT.userId, DEV_CONTEXT.userGroupIds)
    for (const repo of repos) {
      if (!repo.clonePath) continue
      const worktreeRunDir = path.join(repo.clonePath, 'worktrees-run')
      if (!fs.existsSync(worktreeRunDir)) continue

      try {
        const entries = fs.readdirSync(worktreeRunDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const worktreePath = path.join(worktreeRunDir, entry.name)
          console.log(`[repoSync] Cleaning up stale worktree: ${worktreePath}`)
          removeWorktree(repo.clonePath, worktreePath).catch((err) =>
            console.error(`[repoSync] Failed to clean up worktree ${worktreePath}:`, err)
          )
        }
      } catch {
        // Ignore errors reading the directory
      }
    }
  }
}
