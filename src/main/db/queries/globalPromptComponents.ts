import { eq } from 'drizzle-orm'
import { getDb } from '../index'
import { globalPromptComponents } from '../schema'
import { getVisibleEntityIds } from './access'
import { deleteSharesForEntity } from './shares'
import type { GlobalPromptComponent, GlobalPromptComponentKind } from '../../../shared/types'
import { validatePromptComponentInput } from '../../../shared/promptComponents'

function rowToComponent(row: typeof globalPromptComponents.$inferSelect): GlobalPromptComponent {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as GlobalPromptComponentKind,
    content: row.content,
    filePath: row.filePath ?? undefined,
    enabled: row.enabled,
    ownerId: row.ownerId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function findFilePathConflict(filePath: string, excludeId?: string): Promise<string | null> {
  const rows = await getDb().select().from(globalPromptComponents)
  const hit = rows.find((r) => r.kind === 'file' && r.filePath === filePath && r.id !== excludeId)
  return hit ? hit.name : null
}

export async function listGlobalPromptComponents(
  userId: string,
  userGroupIds: string[]
): Promise<GlobalPromptComponent[]> {
  const visibleIds = await getVisibleEntityIds('globalPromptComponent', userId, userGroupIds)
  if (visibleIds.length === 0) return []
  const rows = await getDb().select().from(globalPromptComponents)
  return rows.filter((r) => visibleIds.includes(r.id)).map(rowToComponent)
}

/** All enabled components — injected into every run regardless of sharing. */
export async function listEnabledGlobalPromptComponents(): Promise<GlobalPromptComponent[]> {
  const rows = await getDb()
    .select()
    .from(globalPromptComponents)
    .where(eq(globalPromptComponents.enabled, true))
  return rows.map(rowToComponent)
}

export async function getGlobalPromptComponent(id: string): Promise<GlobalPromptComponent | null> {
  const rows = await getDb()
    .select()
    .from(globalPromptComponents)
    .where(eq(globalPromptComponents.id, id))
  return rows.length ? rowToComponent(rows[0]) : null
}

export async function createGlobalPromptComponent(
  data: Omit<GlobalPromptComponent, 'id' | 'createdAt' | 'updatedAt'>,
  ownerId: string
): Promise<GlobalPromptComponent> {
  const validated = validatePromptComponentInput(data)
  if (validated.kind === 'file' && validated.filePath) {
    const conflict = await findFilePathConflict(validated.filePath)
    if (conflict) {
      throw new Error(
        `A file component already writes "${validated.filePath}" (component "${conflict}"). File paths must be unique.`
      )
    }
  }

  const now = Date.now()
  const id = crypto.randomUUID()
  await getDb().insert(globalPromptComponents).values({
    id,
    name: data.name.trim(),
    kind: validated.kind,
    content: data.content ?? '',
    filePath: validated.kind === 'file' ? validated.filePath : null,
    enabled: data.enabled,
    ownerId,
    createdAt: now,
    updatedAt: now,
  })

  const rows = await getDb()
    .select()
    .from(globalPromptComponents)
    .where(eq(globalPromptComponents.id, id))
  if (rows.length === 0) throw new Error(`Failed to create prompt component with id ${id}`)
  return rowToComponent(rows[0])
}

export async function updateGlobalPromptComponent(
  id: string,
  data: Partial<Omit<GlobalPromptComponent, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<GlobalPromptComponent> {
  const existing = await getGlobalPromptComponent(id)
  if (!existing) throw new Error(`Prompt component with id ${id} not found`)

  const merged = {
    name: data.name ?? existing.name,
    kind: data.kind ?? existing.kind,
    content: data.content ?? existing.content,
    filePath: data.filePath !== undefined ? data.filePath : existing.filePath,
    enabled: data.enabled ?? existing.enabled,
  }
  const validated = validatePromptComponentInput(merged)
  if (validated.kind === 'file' && validated.filePath) {
    const conflict = await findFilePathConflict(validated.filePath, id)
    if (conflict) {
      throw new Error(
        `A file component already writes "${validated.filePath}" (component "${conflict}"). File paths must be unique.`
      )
    }
  }

  await getDb()
    .update(globalPromptComponents)
    .set({
      name: merged.name.trim(),
      kind: validated.kind,
      content: merged.content,
      filePath: validated.kind === 'file' ? validated.filePath : null,
      enabled: merged.enabled,
      updatedAt: Date.now(),
    })
    .where(eq(globalPromptComponents.id, id))

  const rows = await getDb()
    .select()
    .from(globalPromptComponents)
    .where(eq(globalPromptComponents.id, id))
  if (rows.length === 0) throw new Error(`Prompt component with id ${id} not found after update`)
  return rowToComponent(rows[0])
}

export async function deleteGlobalPromptComponent(id: string): Promise<number> {
  await deleteSharesForEntity('globalPromptComponent', id)
  const deleted = await getDb()
    .delete(globalPromptComponents)
    .where(eq(globalPromptComponents.id, id))
    .returning({ id: globalPromptComponents.id })
  return deleted.length
}
