import * as fs from 'fs'
import * as path from 'path'
import { eq } from 'drizzle-orm'
import { drizzleDb } from '../index'
import { repositories, agents } from '../schema'
import { REPOS_DIR } from '../../utils/paths'
import type { Repository } from '../../../shared/types'

function rowToRepository(row: typeof repositories.$inferSelect): Repository {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    defaultBranch: row.defaultBranch,
    authMethod: row.authMethod as Repository['authMethod'],
    syncStatus: row.syncStatus as Repository['syncStatus'],
    syncError: row.syncError ?? undefined,
    lastSyncedAt: row.lastSyncedAt ?? undefined,
    clonePath: row.clonePath ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function listRepositories(): Repository[] {
  const rows = drizzleDb.select().from(repositories).all()
  return rows.map(rowToRepository)
}

export function getRepository(id: string): Repository | null {
  const rows = drizzleDb.select().from(repositories).where(eq(repositories.id, id)).all()
  if (rows.length === 0) return null
  return rowToRepository(rows[0])
}

export function createRepository(
  data: Omit<Repository, 'id' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'clonePath'>
): Repository {
  const now = Date.now()
  const id = crypto.randomUUID()
  const clonePath = path.join(REPOS_DIR, id)

  drizzleDb.insert(repositories).values({
    id,
    name: data.name,
    url: data.url,
    defaultBranch: data.defaultBranch ?? 'main',
    authMethod: data.authMethod ?? 'none',
    syncStatus: 'pending',
    clonePath,
    createdAt: now,
    updatedAt: now,
  }).run()

  const created = getRepository(id)
  if (!created) throw new Error(`Failed to create repository with id ${id}`)
  return created
}

export function updateRepository(
  id: string,
  data: Partial<Omit<Repository, 'id' | 'createdAt' | 'updatedAt'>>
): Repository {
  const now = Date.now()

  const updateValues: Partial<typeof repositories.$inferInsert> = {
    updatedAt: now,
  }

  if (data.name !== undefined) updateValues.name = data.name
  if (data.url !== undefined) updateValues.url = data.url
  if (data.defaultBranch !== undefined) updateValues.defaultBranch = data.defaultBranch
  if (data.authMethod !== undefined) updateValues.authMethod = data.authMethod
  if (data.syncStatus !== undefined) updateValues.syncStatus = data.syncStatus
  if ('syncError' in data) updateValues.syncError = data.syncError ?? null
  if ('lastSyncedAt' in data) updateValues.lastSyncedAt = data.lastSyncedAt ?? null
  if ('clonePath' in data) updateValues.clonePath = data.clonePath ?? null

  drizzleDb.update(repositories).set(updateValues).where(eq(repositories.id, id)).run()

  const updated = getRepository(id)
  if (!updated) throw new Error(`Repository with id ${id} not found after update`)
  return updated
}

export function deleteRepository(id: string): void {
  // Unset repositoryId on any agents referencing this repo
  const allAgents = drizzleDb.select().from(agents).all()
  for (const agent of allAgents) {
    if (agent.repositoryId === id) {
      drizzleDb.update(agents).set({ repositoryId: null }).where(eq(agents.id, agent.id)).run()
    }
  }

  // Get clone path before deleting the record
  const repo = getRepository(id)
  const clonePath = repo?.clonePath

  drizzleDb.delete(repositories).where(eq(repositories.id, id)).run()

  // Clean up on-disk clone
  if (clonePath) {
    try {
      fs.rmSync(clonePath, { recursive: true, force: true })
    } catch {
      // Ignore — directory may not exist
    }
  }
}
