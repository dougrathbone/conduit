import { eq, and } from 'drizzle-orm'
import { drizzleDb } from '../index'
import { shares } from '../schema'
import type { Share, ShareableEntityType } from '../../../shared/types'

function rowToShare(row: typeof shares.$inferSelect): Share {
  return {
    id: row.id,
    entityType: row.entityType as ShareableEntityType,
    entityId: row.entityId,
    targetType: row.targetType as Share['targetType'],
    targetId: row.targetId ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

export function getShare(id: string): Share | null {
  const rows = drizzleDb.select().from(shares).where(eq(shares.id, id)).all()
  if (rows.length === 0) return null
  return rowToShare(rows[0])
}

export function listShares(entityType: ShareableEntityType, entityId: string): Share[] {
  const rows = drizzleDb
    .select()
    .from(shares)
    .where(and(eq(shares.entityType, entityType), eq(shares.entityId, entityId)))
    .all()
  return rows.map(rowToShare)
}

export function createShare(data: {
  entityType: ShareableEntityType
  entityId: string
  targetType: 'user' | 'group' | 'everyone'
  targetId?: string
  createdBy: string
}): Share {
  const id = crypto.randomUUID()
  const now = Date.now()

  drizzleDb.insert(shares).values({
    id,
    entityType: data.entityType,
    entityId: data.entityId,
    targetType: data.targetType,
    targetId: data.targetType === 'everyone' ? null : (data.targetId ?? null),
    createdBy: data.createdBy,
    createdAt: now,
  }).run()

  const rows = drizzleDb.select().from(shares).where(eq(shares.id, id)).all()
  if (rows.length === 0) throw new Error(`Failed to create share with id ${id}`)
  return rowToShare(rows[0])
}

export function deleteShare(id: string): void {
  drizzleDb.delete(shares).where(eq(shares.id, id)).run()
}

export function deleteSharesForEntity(entityType: ShareableEntityType, entityId: string): void {
  drizzleDb
    .delete(shares)
    .where(and(eq(shares.entityType, entityType), eq(shares.entityId, entityId)))
    .run()
}
