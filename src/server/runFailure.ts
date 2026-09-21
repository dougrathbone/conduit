import { isDiskFullError } from './gitOps'
import type { CaptureContext, SeverityLevel } from '../shared/observability'
import type { RunnerType } from '../shared/types'

/** A run-failure captured for the error reporter. */
export interface RunFailureReport {
  message: string
  level: SeverityLevel
  ctx: CaptureContext
}

/**
 * Operator-facing run-failure copy. Run failures used to be invisible in
 * Sentry — a non-zero agent exit (or a process killed when the disk filled)
 * was written to the DB as `failed` and never captured.
 */

/** Persist this on the run row when worker prep (clone, worktree, spawn) throws. */
export function failedStartLastLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `Failed to start run: ${msg}`
}

/**
 * Operator-facing line when the CLI did not exit on its own. SIGTERM is the
 * cooperative cancel path (`stopRun`) and is not described here.
 */
export function killedBySignalLastLine(signal?: string): string {
  const sig = signal ? ` (${signal})` : ''
  return (
    `✗ Run process was killed${sig} — typically out-of-memory or disk-pressure ` +
    'eviction. Check the Conduit pod memory limit and data volume.'
  )
}

/**
 * Diagnostic to emit when the agent CLI is gone because of a kill, not a
 * normal non-zero exit. `137` is 128+SIGKILL when the runtime reports a
 * numeric code instead of `null` + signal.
 */
export function cliKillDiagnostic(
  code: number | null | undefined,
  signal?: string | null
): string | undefined {
  if (code === 0) return undefined
  if (code === 137) return killedBySignalLastLine('SIGKILL')
  if ((code == null || code === undefined) && signal && signal !== 'SIGTERM') {
    return killedBySignalLastLine(signal)
  }
  return undefined
}

/**
 * Build the error-reporter payload for a failed agent run.
 *
 * A disk-exhaustion failure is escalated to `error` and tagged `diskFull:true`
 * so it can be alerted on directly; other failures report at `warning`. The
 * exit code is normalised — `null` means the process was killed by a signal
 * (e.g. OOM / eviction), rendered as "signal".
 */
export function buildRunFailureReport(opts: {
  runId: string
  runner: RunnerType
  exitCode: number | null | undefined
  lastLine: string | undefined
}): RunFailureReport {
  const { runId, runner, exitCode, lastLine } = opts
  const diskFull = isDiskFullError(lastLine ?? '')
  // `null`/`undefined` exit code ⇒ the process was killed by a signal rather than
  // exiting on its own — typically an OOM kill or a disk-pressure eviction of the
  // agent process. These are the failures that leave the log "just stopping", so
  // escalate them to `error` (like disk-full) instead of hiding them at `warning`.
  const killedBySignal = typeof exitCode !== 'number'
  const exitCodeTag = killedBySignal ? 'signal' : String(exitCode)
  return {
    message: `Agent run failed (exit ${exitCodeTag})`,
    level: diskFull || killedBySignal ? 'error' : 'warning',
    ctx: {
      tags: {
        component: 'runner',
        op: 'runExit',
        runId,
        runner,
        exitCode: exitCodeTag,
        diskFull: String(diskFull),
        killedBySignal: String(killedBySignal),
      },
      extra: { lastLine: lastLine || undefined },
    },
  }
}
