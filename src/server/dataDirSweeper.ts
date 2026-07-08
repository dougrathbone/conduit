import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { REPOS_DIR } from '../main/utils/paths'
import { removeWorktree } from './gitOps'
import { deleteWorkspace } from '../main/execution/workspace'
import { getActiveWorkspacePaths, getActiveRunIds } from './runner'
import { reporter } from './observability'
import type { SweepResult } from '../shared/types'

/**
 * Periodic + on-demand cleaner for the data directory.
 *
 * Each agent run leaves behind run artifacts — a git worktree (a full checkout,
 * gigabytes for a large monorepo), and for repo-less runs an ephemeral temp
 * workspace plus a per-run MCP config file. Normally `cleanupRun` removes them a
 * few seconds after a run ends, but leaks happen (failed cleanup, a crashed/
 * evicted pod, or a run that dies between creating its worktree and registering
 * as active). Left unchecked these accumulate and exhaust the pod's disk.
 *
 * This sweeper reclaims that space. Its one hard invariant: **never delete an
 * artifact belonging to a run currently executing on this pod.** Two independent
 * guards enforce it — the live active-set from the runner, and a grace period
 * that spares very-recent artifacts (covering the brief window between a
 * worktree being created and its run registering as active).
 */

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000 // 10 min
const DEFAULT_GRACE_MS = 5 * 60 * 1000 // 5 min

function envMs(raw: string | undefined, fallback: number): number {
  const n = raw !== undefined ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export const SWEEP_INTERVAL_MS = envMs(process.env.CONDUIT_SWEEP_INTERVAL_MS, DEFAULT_INTERVAL_MS)
export const SWEEP_GRACE_MS = envMs(process.env.CONDUIT_SWEEP_GRACE_MS, DEFAULT_GRACE_MS)

/** A candidate artifact considered for removal. */
export interface SweepEntry {
  /** Stable identifier (used for logging + tests). */
  key: string
  /** Last-modified time in epoch ms. */
  mtimeMs: number
  /** True when this artifact belongs to a run currently executing on this pod. */
  protectedByActive: boolean
}

/**
 * Pure decision core: from candidate entries, return exactly those safe to
 * remove — not tied to a live run, and older than the grace period. Kept free of
 * I/O so the safety logic is unit-testable in isolation.
 */
export function selectStale<T extends SweepEntry>(
  entries: T[],
  opts: { now: number; graceMs: number }
): T[] {
  return entries.filter((e) => !e.protectedByActive && opts.now - e.mtimeMs >= opts.graceMs)
}

// A run's ephemeral workspace is `conduit-<uuid>-<mkdtemp suffix>`; its MCP
// config is `conduit-mcp-<uuid>.json`. Match the uuid precisely so we never
// touch unrelated temp entries (and so workspaces aren't confused with configs).
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const WORKSPACE_DIR_RE = new RegExp(`^conduit-(${UUID})-`, 'i')
const MCP_CONFIG_RE = new RegExp(`^conduit-mcp-(${UUID})\\.json$`, 'i')

export type TmpEntryKind = 'workspace' | 'mcpConfig' | 'other'

/**
 * Classify a temp-dir entry name as a Conduit run artifact. Deliberately strict
 * (matches the exact `conduit-<uuid>-…` / `conduit-mcp-<uuid>.json` shapes) so
 * the sweeper never touches unrelated temp files. The MCP-config check is tried
 * first because `conduit-mcp-…` also starts with `conduit-`.
 */
export function classifyTmpEntry(name: string): { kind: TmpEntryKind; runId?: string } {
  const mcp = MCP_CONFIG_RE.exec(name)
  if (mcp) return { kind: 'mcpConfig', runId: mcp[1] }
  const ws = WORKSPACE_DIR_RE.exec(name)
  if (ws) return { kind: 'workspace', runId: ws[1] }
  return { kind: 'other' }
}

function safeMtimeMs(p: string): number {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0 // unreadable → treat as old (past grace) so it can be cleaned
  }
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

let inFlightSweep: Promise<SweepResult> | null = null

/**
 * Run one sweep now, coalescing concurrent callers. Startup, the periodic timer,
 * the per-run-finish hook, and the manual Settings trigger can all fire close
 * together; they share a single in-flight sweep rather than scanning redundantly.
 */
export function sweepOnce(now: number = Date.now()): Promise<SweepResult> {
  if (inFlightSweep) return inFlightSweep
  inFlightSweep = runSweep(now).finally(() => {
    inFlightSweep = null
  })
  return inFlightSweep
}

/**
 * Scan the three artifact categories, remove stale ones, and return/log a
 * summary. Never throws — per-entry failures are swallowed so one bad entry
 * can't abort the sweep.
 */
async function runSweep(now: number): Promise<SweepResult> {
  const activePaths = getActiveWorkspacePaths()
  const activeRunIds = getActiveRunIds()
  const result: SweepResult = { worktreesRemoved: 0, workspacesRemoved: 0, mcpConfigsRemoved: 0 }

  // 1. Git worktrees: REPOS_DIR/<repoId>/worktrees-run/<uuid>
  for (const repoEntry of listDir(REPOS_DIR)) {
    if (!repoEntry.isDirectory()) continue
    const clonePath = path.join(REPOS_DIR, repoEntry.name)
    const worktreesDir = path.join(clonePath, 'worktrees-run')
    const candidates: (SweepEntry & { path: string })[] = listDir(worktreesDir)
      .filter((e) => e.isDirectory())
      .map((e) => {
        const p = path.join(worktreesDir, e.name)
        return { key: p, path: p, mtimeMs: safeMtimeMs(p), protectedByActive: activePaths.has(p) }
      })
    for (const stale of selectStale(candidates, { now, graceMs: SWEEP_GRACE_MS })) {
      try {
        await removeWorktree(clonePath, stale.path)
        if (!fs.existsSync(stale.path)) result.worktreesRemoved++
      } catch (err) {
        reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'worktree' } })
      }
    }
  }

  // 2 & 3. Temp-dir artifacts: ephemeral workspaces + per-run MCP configs.
  const tmp = os.tmpdir()
  const workspaceCandidates: (SweepEntry & { path: string })[] = []
  const mcpCandidates: (SweepEntry & { path: string })[] = []
  for (const entry of listDir(tmp)) {
    const cls = classifyTmpEntry(entry.name)
    if (cls.kind === 'other') continue
    const p = path.join(tmp, entry.name)
    if (cls.kind === 'mcpConfig' && entry.isFile()) {
      mcpCandidates.push({
        key: p,
        path: p,
        mtimeMs: safeMtimeMs(p),
        protectedByActive: activeRunIds.has(cls.runId!),
      })
    } else if (cls.kind === 'workspace' && entry.isDirectory()) {
      workspaceCandidates.push({
        key: p,
        path: p,
        mtimeMs: safeMtimeMs(p),
        protectedByActive: activePaths.has(p),
      })
    }
  }

  for (const stale of selectStale(workspaceCandidates, { now, graceMs: SWEEP_GRACE_MS })) {
    deleteWorkspace(stale.path) // swallows its own errors
    if (!fs.existsSync(stale.path)) result.workspacesRemoved++
  }
  for (const stale of selectStale(mcpCandidates, { now, graceMs: SWEEP_GRACE_MS })) {
    try {
      fs.rmSync(stale.path, { force: true })
      result.mcpConfigsRemoved++
    } catch (err) {
      reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'mcpConfig' } })
    }
  }

  const total = result.worktreesRemoved + result.workspacesRemoved + result.mcpConfigsRemoved
  if (total > 0) {
    console.log(
      `[dataDirSweeper] Removed ${result.worktreesRemoved} worktree(s), ` +
        `${result.workspacesRemoved} workspace(s), ${result.mcpConfigsRemoved} MCP config(s).`
    )
  }
  return result
}

/**
 * Background service: one immediate sweep on start (reclaiming anything left by a
 * previous process), then a sweep every `intervalMs`.
 */
export class DataDirSweeper {
  private intervalId: NodeJS.Timeout | null = null

  start(intervalMs: number = SWEEP_INTERVAL_MS): void {
    sweepOnce().catch((err) =>
      reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'startup' } })
    )
    this.intervalId = setInterval(() => {
      sweepOnce().catch((err) =>
        reporter.captureException(err, { tags: { component: 'dataDirSweeper', op: 'periodic' } })
      )
    }, intervalMs)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }
}
