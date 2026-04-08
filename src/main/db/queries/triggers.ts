import { eq } from 'drizzle-orm'
import { drizzleDb } from '../index'
import { triggers } from '../schema'
import type { Trigger, TriggerConfig } from '../../../shared/types'

function rowToTrigger(row: typeof triggers.$inferSelect): Trigger {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    type: row.type as Trigger['type'],
    config: JSON.parse(row.config) as TriggerConfig,
    enabled: row.enabled === 1,
    lastTriggeredAt: row.lastTriggeredAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function listTriggers(agentId: string): Trigger[] {
  const rows = drizzleDb.select().from(triggers).where(eq(triggers.agentId, agentId)).all()
  return rows.map(rowToTrigger)
}

export function listAllEnabledTriggers(): Trigger[] {
  const rows = drizzleDb.select().from(triggers).where(eq(triggers.enabled, 1)).all()
  return rows.map(rowToTrigger)
}

export function getTrigger(id: string): Trigger | null {
  const rows = drizzleDb.select().from(triggers).where(eq(triggers.id, id)).all()
  if (rows.length === 0) return null
  return rowToTrigger(rows[0])
}

export function createTrigger(
  data: Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>
): Trigger {
  const now = Date.now()
  const id = crypto.randomUUID()

  drizzleDb.insert(triggers).values({
    id,
    agentId: data.agentId,
    name: data.name,
    type: data.type,
    config: JSON.stringify(data.config),
    enabled: data.enabled ? 1 : 0,
    lastTriggeredAt: data.lastTriggeredAt ?? null,
    createdAt: now,
    updatedAt: now,
  }).run()

  const created = getTrigger(id)
  if (!created) throw new Error(`Failed to create trigger with id ${id}`)
  return created
}

export function updateTrigger(
  id: string,
  data: Partial<Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>>
): Trigger {
  const now = Date.now()
  const updateValues: Partial<typeof triggers.$inferInsert> = { updatedAt: now }

  if (data.name !== undefined) updateValues.name = data.name
  if (data.type !== undefined) updateValues.type = data.type
  if (data.config !== undefined) updateValues.config = JSON.stringify(data.config)
  if (data.enabled !== undefined) updateValues.enabled = data.enabled ? 1 : 0
  if (data.lastTriggeredAt !== undefined) updateValues.lastTriggeredAt = data.lastTriggeredAt

  drizzleDb.update(triggers).set(updateValues).where(eq(triggers.id, id)).run()

  const updated = getTrigger(id)
  if (!updated) throw new Error(`Trigger with id ${id} not found after update`)
  return updated
}

export function deleteTrigger(id: string): void {
  drizzleDb.delete(triggers).where(eq(triggers.id, id)).run()
}
