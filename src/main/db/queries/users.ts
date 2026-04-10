import { eq, like, or } from 'drizzle-orm'
import { drizzleDb } from '../index'
import { users } from '../schema'
import type { User } from '../../../shared/types'

function rowToUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl ?? undefined,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  }
}

export function upsertUser(data: {
  id: string
  email: string
  name: string
  avatarUrl?: string
}): User {
  const now = Date.now()

  drizzleDb.insert(users).values({
    id: data.id,
    email: data.email,
    name: data.name,
    avatarUrl: data.avatarUrl ?? null,
    lastLoginAt: now,
    createdAt: now,
  }).onConflictDoUpdate({
    target: users.id,
    set: {
      email: data.email,
      name: data.name,
      avatarUrl: data.avatarUrl ?? null,
      lastLoginAt: now,
    },
  }).run()

  const row = drizzleDb.select().from(users).where(eq(users.id, data.id)).get()
  if (!row) throw new Error(`Failed to upsert user with id ${data.id}`)
  return rowToUser(row)
}

export function getUser(id: string): User | null {
  const row = drizzleDb.select().from(users).where(eq(users.id, id)).get()
  if (!row) return null
  return rowToUser(row)
}

export function listUsers(): User[] {
  const rows = drizzleDb.select().from(users).all()
  return rows.map(rowToUser)
}

export function searchUsers(query: string): User[] {
  const pattern = `%${query}%`
  const rows = drizzleDb
    .select()
    .from(users)
    .where(or(like(users.name, pattern), like(users.email, pattern)))
    .all()
  return rows.map(rowToUser)
}
