import { classifyRunFailure } from '../runFailure'

/**
 * Resuming a cursor-agent session after the model provider drops the stream.
 *
 * cursor-agent talks to the Cursor API over one long-lived HTTP/2 stream. When
 * that stream is cancelled mid-run (`RetriableError: [canceled] http/2 stream
 * closed …`, `[resource_exhausted]`) the CLI exits 1 — even an hour into a run
 * that has already opened PRs. Restarting the whole run would redo that work,
 * so the worker instead respawns the CLI with `--resume <session>`: the
 * conversation and the workspace are intact, only the connection was lost.
 *
 * Narrow on purpose: only when the CLI's own last stderr line is a transient
 * provider diagnostic (the same classification the run-level retry uses), the
 * process exited non-zero on its own, and we know the session id.
 */

/** Resumes allowed per run after the first launch. `0` turns this off. */
export const DEFAULT_CURSOR_RESUME_MAX_ATTEMPTS = 3
/** Wait before resume n (1-based); the last entry repeats. */
export const CURSOR_RESUME_DELAYS_MS = [15_000, 60_000, 180_000]

/** What the resumed session is told: it keeps its history, so don't restart the task. */
export const CURSOR_RESUME_PROMPT =
  'Your connection to the model provider dropped mid-run and the session was resumed. ' +
  'Continue the task from exactly where you left off. Do not start over or repeat work ' +
  'you already completed; check the current state (git status, open PRs, etc.) if unsure ' +
  'what finished before the interruption, then carry on to the end, including any final ' +
  'output the original instructions require.'

export function resolveCursorResumeMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CONDUIT_CURSOR_RESUME_MAX_ATTEMPTS?.trim()
  if (!raw) return DEFAULT_CURSOR_RESUME_MAX_ATTEMPTS
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_CURSOR_RESUME_MAX_ATTEMPTS
}

export function cursorResumeDelayMs(attempt: number): number {
  return CURSOR_RESUME_DELAYS_MS[Math.min(Math.max(attempt, 1), CURSOR_RESUME_DELAYS_MS.length) - 1]!
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  return lines.length > 0 ? lines[lines.length - 1]! : ''
}

/** True when a CLI that just exited should be respawned with `--resume`. */
export function shouldResumeCursor(opts: {
  sessionId: string | undefined
  exitCode: number | null
  /** Recent stderr; only its last non-empty line is judged. */
  stderrTail: string
  /** Resumes already used (0 before the first). */
  attempt: number
  maxAttempts: number
}): boolean {
  const { sessionId, exitCode, stderrTail, attempt, maxAttempts } = opts
  if (!sessionId) return false
  if (typeof exitCode !== 'number' || exitCode === 0) return false
  if (attempt >= maxAttempts) return false
  return classifyRunFailure(lastNonEmptyLine(stderrTail), exitCode) === 'provider_unavailable'
}
