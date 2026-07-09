import { and, eq } from 'drizzle-orm'
import { getDb } from '../index'
import { runnerSettings } from '../schema'
import type { RunnerTimeouts, RunnerType } from '../../../shared/types'

const RUNNERS: RunnerType[] = ['claude', 'amp', 'cursor']

/** A user's per-runner background-task timeout in seconds (0 = indefinite). Absent rows default to 0. */
export async function getRunnerTimeouts(userId: string): Promise<RunnerTimeouts> {
  const rows = await getDb().select().from(runnerSettings).where(eq(runnerSettings.userId, userId))
  const byRunner = new Map(rows.map((r) => [r.runner, r.bgTaskTimeoutSeconds]))
  return {
    claude: byRunner.get('claude') ?? 0,
    amp: byRunner.get('amp') ?? 0,
    cursor: byRunner.get('cursor') ?? 0,
  }
}

/**
 * Set a user's background-task timeout for a runner, in seconds. A 0 (or negative)
 * value clears the row so the runner falls back to the default (0 = indefinite).
 */
export async function setRunnerTimeout(userId: string, runner: RunnerType, seconds: number): Promise<void> {
  if (!RUNNERS.includes(runner)) throw new Error(`Unknown runner: ${runner}`)
  const normalized = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  if (normalized === 0) {
    await getDb().delete(runnerSettings)
      .where(and(eq(runnerSettings.userId, userId), eq(runnerSettings.runner, runner)))
    return
  }
  const values = { userId, runner, bgTaskTimeoutSeconds: normalized, updatedAt: Date.now() }
  await getDb().insert(runnerSettings).values(values).onConflictDoUpdate({
    target: [runnerSettings.userId, runnerSettings.runner],
    set: { bgTaskTimeoutSeconds: values.bgTaskTimeoutSeconds, updatedAt: values.updatedAt },
  })
}

/** A user's timeout for one runner in seconds, or null if unset (server-side, for env injection). */
export async function getRunnerTimeout(userId: string, runner: RunnerType): Promise<number | null> {
  const rows = await getDb().select().from(runnerSettings)
    .where(and(eq(runnerSettings.userId, userId), eq(runnerSettings.runner, runner)))
  if (rows.length === 0) return null
  return rows[0].bgTaskTimeoutSeconds
}
