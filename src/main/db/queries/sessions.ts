import { eq, lt } from 'drizzle-orm'
import { drizzleDb } from '../index'
import { sessions } from '../schema'

export function createSession(data: {
  userId: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
}) {
  const id = crypto.randomUUID()
  const now = Date.now()

  drizzleDb.insert(sessions).values({
    id,
    userId: data.userId,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresAt: data.expiresAt,
    createdAt: now,
  }).run()

  const row = drizzleDb.select().from(sessions).where(eq(sessions.id, id)).get()
  if (!row) throw new Error(`Failed to create session with id ${id}`)
  return row
}

export function getSession(id: string) {
  return drizzleDb.select().from(sessions).where(eq(sessions.id, id)).get() ?? null
}

export function deleteSession(id: string) {
  drizzleDb.delete(sessions).where(eq(sessions.id, id)).run()
}

export function deleteExpiredSessions(): number {
  const now = Date.now()
  const result = drizzleDb.delete(sessions).where(lt(sessions.expiresAt, now)).run()
  return result.changes
}

export function updateSessionTokens(
  id: string,
  data: { accessToken: string; refreshToken?: string; expiresAt: number }
) {
  drizzleDb.update(sessions).set({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresAt: data.expiresAt,
  }).where(eq(sessions.id, id)).run()
}
