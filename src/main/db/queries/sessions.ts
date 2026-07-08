import { eq, lt } from 'drizzle-orm'
import { getDb } from '../index'
import { sessions } from '../schema'

export async function createSession(data: {
  userId: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
}) {
  const id = crypto.randomUUID()
  const now = Date.now()

  await getDb().insert(sessions).values({
    id,
    userId: data.userId,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresAt: data.expiresAt,
    createdAt: now,
  })

  const rows = await getDb().select().from(sessions).where(eq(sessions.id, id))
  if (rows.length === 0) throw new Error(`Failed to create session with id ${id}`)
  return rows[0]
}

export async function getSession(id: string) {
  const rows = await getDb().select().from(sessions).where(eq(sessions.id, id))
  const session = rows[0]
  if (!session) return null
  // Expiry is enforced here, at the single source of truth, so every consumer
  // (REST middleware, WebSocket upgrade, and /auth/me) treats an expired
  // session as unauthenticated. Purge the stale row so it never lingers, but
  // treat that cleanup as best-effort: returning null for an expired session
  // must not depend on the delete succeeding (a failed write must not throw and
  // hang the caller — the hourly sweep will reclaim the row regardless).
  if (session.expiresAt < Date.now()) {
    try {
      await deleteSession(session.id)
    } catch {
      // ignore — the session is still treated as expired below
    }
    return null
  }
  return session
}

export async function deleteSession(id: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.id, id))
}

export async function deleteExpiredSessions(): Promise<number> {
  const now = Date.now()
  const deleted = await getDb()
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id })
  return deleted.length
}

export async function updateSessionTokens(
  id: string,
  data: { accessToken: string; refreshToken?: string; expiresAt: number }
): Promise<void> {
  await getDb().update(sessions).set({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresAt: data.expiresAt,
  }).where(eq(sessions.id, id))
}
