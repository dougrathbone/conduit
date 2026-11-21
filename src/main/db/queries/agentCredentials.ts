import { and, eq } from 'drizzle-orm'
import { getDb } from '../index'
import { agentCredentials } from '../schema'
import { encryptSecret, decryptSecret } from '../../../server/crypto'
import type { AgentCredentialStatus, RunnerType } from '../../../shared/types'

const RUNNERS: RunnerType[] = ['claude', 'amp', 'cursor']

/** Which runners the given user has a credential stored for (never the secret). */
export async function getCredentialStatus(userId: string): Promise<AgentCredentialStatus> {
  const rows = await getDb().select().from(agentCredentials).where(eq(agentCredentials.userId, userId))
  const configured = new Set(rows.map((r) => r.runner))
  return {
    claude: configured.has('claude'),
    amp: configured.has('amp'),
    cursor: configured.has('cursor'),
  }
}

/**
 * Store (encrypted) or clear a user's credential for a runner. An empty/blank
 * value deletes the row so a run falls back to another user's key for that CLI,
 * then the worker's own environment.
 */
export async function setCredential(userId: string, runner: RunnerType, value: string): Promise<void> {
  if (!RUNNERS.includes(runner)) throw new Error(`Unknown runner: ${runner}`)
  const trimmed = value.trim()
  if (!trimmed) {
    await getDb().delete(agentCredentials)
      .where(and(eq(agentCredentials.userId, userId), eq(agentCredentials.runner, runner)))
    return
  }
  const values = {
    userId,
    runner,
    valueEnc: encryptSecret(trimmed),
    updatedAt: Date.now(),
  }
  await getDb().insert(agentCredentials).values(values).onConflictDoUpdate({
    target: [agentCredentials.userId, agentCredentials.runner],
    set: { valueEnc: values.valueEnc, updatedAt: values.updatedAt },
  })
}

/**
 * Key injected into a run. The acting user's own key wins. When they have not
 * saved one, any user's key for that CLI is shared — the most recently saved
 * wins — so a scheduled run of someone else's agent still authenticates.
 */
export async function resolveRunnerCredential(userId: string, runner: RunnerType): Promise<string | null> {
  const rows = await getDb().select().from(agentCredentials).where(eq(agentCredentials.runner, runner))
  const own = rows.find((row) => row.userId === userId)
  if (own) {
    const value = decryptSecret(own.valueEnc).trim()
    if (value) return value
  }
  const shared = rows
    .filter((row) => row.userId !== userId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  for (const row of shared) {
    const value = decryptSecret(row.valueEnc).trim()
    if (value) return value
  }
  return null
}
