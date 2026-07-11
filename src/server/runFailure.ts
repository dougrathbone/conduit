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
 * Build the error-reporter payload for a failed agent run.
 *
 * Run failures used to be invisible in Sentry — a non-zero agent exit (or a
 * process killed when the disk filled) was written to the DB as `failed` and
 * never captured, so the operator had no signal that runs were dying. A
 * disk-exhaustion failure is escalated to `error` level and tagged
 * `diskFull:true` so it can be alerted on directly; other failures report at
 * `warning`. The exit code is normalised — `null` means the process was killed
 * by a signal (e.g. OOM / eviction), rendered as "signal".
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
