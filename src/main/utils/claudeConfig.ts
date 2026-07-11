import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/**
 * Per-run Claude Code config directory (pointed at by CLAUDE_CONFIG_DIR).
 *
 * Claude Code gates a repo's `.claude/settings.json` `permissions.allow` behind a
 * workspace-trust flag. Launched headlessly (`-p`), the trust dialog never
 * appears and `--dangerously-skip-permissions` does NOT bypass it, so every run
 * logs "this workspace has not been trusted" and silently drops those
 * permissions. We give each run an isolated CLAUDE_CONFIG_DIR seeded with the
 * workspace pre-trusted, which both silences the warning and lets the repo's
 * settings apply — without mutating the operator's real `~/.claude.json`.
 *
 * Kept separate from the shared config on purpose: `.claude.json` trust is keyed
 * by absolute path, and run worktree paths are per-run and ephemeral.
 */

function claudeConfigDir(runId: string): string {
  return path.join(os.tmpdir(), `conduit-claude-${runId}`)
}

/**
 * Create an isolated Claude config dir for a run, pre-trusting the given paths,
 * and return the dir to set as `CLAUDE_CONFIG_DIR`. Claude keys trust by the git
 * root (bare clone) for a worktree, or the resolved cwd for a non-git workspace,
 * so callers should pass every candidate (workspace path + clone path).
 */
export function writeClaudeConfig(runId: string, trustedPaths: string[]): string {
  const dir = claudeConfigDir(runId)
  fs.mkdirSync(dir, { recursive: true })
  const projects: Record<string, { hasTrustDialogAccepted: boolean }> = {}
  for (const p of trustedPaths) {
    if (p) projects[p] = { hasTrustDialogAccepted: true }
  }
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ projects }, null, 2))
  return dir
}

/** Remove a run's isolated Claude config dir (best-effort; small, but tidy). */
export function deleteClaudeConfig(runId: string): void {
  try {
    fs.rmSync(claudeConfigDir(runId), { recursive: true, force: true })
  } catch {
    // best-effort — a tiny JSON dir; the run is over
  }
}
