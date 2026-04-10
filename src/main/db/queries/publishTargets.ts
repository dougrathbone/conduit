import { eq } from 'drizzle-orm'
import { drizzleDb } from '../index'
import { publishTargets } from '../schema'
import { getVisibleEntityIds } from './access'
import { deleteSharesForEntity } from './shares'
import type { PublishTarget, SlackPublishConfig } from '../../../shared/types'

function rowToPublishTarget(row: typeof publishTargets.$inferSelect): PublishTarget {
  return {
    id: row.id,
    name: row.name,
    type: row.type as PublishTarget['type'],
    config: JSON.parse(row.config) as SlackPublishConfig,
    enabled: row.enabled === 1,
    ownerId: row.ownerId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function listPublishTargets(userId: string, userGroupIds: string[]): PublishTarget[] {
  const visibleIds = getVisibleEntityIds('publishTarget', userId, userGroupIds)
  if (visibleIds.length === 0) return []
  const rows = drizzleDb.select().from(publishTargets).all()
  return rows.filter(r => visibleIds.includes(r.id)).map(rowToPublishTarget)
}

export function getPublishTarget(id: string): PublishTarget | null {
  const rows = drizzleDb.select().from(publishTargets).where(eq(publishTargets.id, id)).all()
  if (rows.length === 0) return null
  return rowToPublishTarget(rows[0])
}

export function createPublishTarget(
  data: Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>,
  ownerId: string
): PublishTarget {
  const now = Date.now()
  const id = crypto.randomUUID()

  drizzleDb.insert(publishTargets).values({
    id,
    name: data.name,
    type: data.type,
    config: JSON.stringify(data.config),
    enabled: data.enabled ? 1 : 0,
    ownerId,
    createdAt: now,
    updatedAt: now,
  }).run()

  const created = getPublishTarget(id)
  if (!created) throw new Error(`Failed to create publish target with id ${id}`)
  return created
}

export function updatePublishTarget(
  id: string,
  data: Partial<Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>>
): PublishTarget {
  const now = Date.now()

  const updateValues: Partial<typeof publishTargets.$inferInsert> = {
    updatedAt: now,
  }

  if (data.name !== undefined) updateValues.name = data.name
  if (data.type !== undefined) updateValues.type = data.type
  if (data.config !== undefined) updateValues.config = JSON.stringify(data.config)
  if (data.enabled !== undefined) updateValues.enabled = data.enabled ? 1 : 0

  drizzleDb.update(publishTargets).set(updateValues).where(eq(publishTargets.id, id)).run()

  const updated = getPublishTarget(id)
  if (!updated) throw new Error(`Publish target with id ${id} not found after update`)
  return updated
}

export function deletePublishTarget(id: string): void {
  deleteSharesForEntity('publishTarget', id)
  drizzleDb.delete(publishTargets).where(eq(publishTargets.id, id)).run()
}
