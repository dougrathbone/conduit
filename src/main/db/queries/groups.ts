import { eq } from 'drizzle-orm'
import { drizzleDb } from '../index'
import { groups, userGroups } from '../schema'
import type { Group } from '../../../shared/types'

function rowToGroup(row: typeof groups.$inferSelect): Group {
  return {
    id: row.id,
    name: row.name,
    parentGroupId: row.parentGroupId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function upsertGroup(data: { id: string; name: string }): Group {
  const now = Date.now()

  drizzleDb.insert(groups).values({
    id: data.id,
    name: data.name,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: groups.id,
    set: {
      name: data.name,
      updatedAt: now,
    },
  }).run()

  const row = drizzleDb.select().from(groups).where(eq(groups.id, data.id)).get()
  if (!row) throw new Error(`Failed to upsert group with id ${data.id}`)
  return rowToGroup(row)
}

export function syncUserGroups(userId: string, groupIds: string[]): void {
  drizzleDb.delete(userGroups).where(eq(userGroups.userId, userId)).run()

  for (const groupId of groupIds) {
    drizzleDb.insert(userGroups).values({
      userId,
      groupId,
    }).run()
  }
}

export function getUserGroupIds(userId: string): string[] {
  const rows = drizzleDb
    .select({ groupId: userGroups.groupId })
    .from(userGroups)
    .where(eq(userGroups.userId, userId))
    .all()
  return rows.map((r) => r.groupId)
}

export function listGroups(): Group[] {
  const rows = drizzleDb.select().from(groups).all()
  return rows.map(rowToGroup)
}
