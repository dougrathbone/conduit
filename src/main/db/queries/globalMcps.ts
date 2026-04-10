import { eq } from 'drizzle-orm'
import { drizzleDb } from '../index'
import { globalMcpServers } from '../schema'
import { getVisibleEntityIds } from './access'
import { deleteSharesForEntity } from './shares'
import type { GlobalMcpServer, McpServerEntry } from '../../../shared/types'

function rowToGlobalMcpServer(row: typeof globalMcpServers.$inferSelect): GlobalMcpServer {
  return {
    id: row.id,
    name: row.name,
    serverKey: row.serverKey,
    serverConfig: JSON.parse(row.serverConfig) as McpServerEntry,
    enabled: row.enabled === 1,
    ownerId: row.ownerId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function listGlobalMcps(userId: string, userGroupIds: string[]): GlobalMcpServer[] {
  const visibleIds = getVisibleEntityIds('globalMcpServer', userId, userGroupIds)
  if (visibleIds.length === 0) return []
  const rows = drizzleDb.select().from(globalMcpServers).all()
  return rows.filter(r => visibleIds.includes(r.id)).map(rowToGlobalMcpServer)
}

export function listEnabledGlobalMcps(): GlobalMcpServer[] {
  const rows = drizzleDb.select().from(globalMcpServers).where(eq(globalMcpServers.enabled, 1)).all()
  return rows.map(rowToGlobalMcpServer)
}

export function createGlobalMcp(
  data: Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>,
  ownerId: string
): GlobalMcpServer {
  const now = Date.now()
  const id = crypto.randomUUID()

  drizzleDb.insert(globalMcpServers).values({
    id,
    name: data.name,
    serverKey: data.serverKey,
    serverConfig: JSON.stringify(data.serverConfig),
    enabled: data.enabled ? 1 : 0,
    ownerId,
    createdAt: now,
    updatedAt: now,
  }).run()

  const rows = drizzleDb.select().from(globalMcpServers).where(eq(globalMcpServers.id, id)).all()
  if (rows.length === 0) throw new Error(`Failed to create global MCP server with id ${id}`)
  return rowToGlobalMcpServer(rows[0])
}

export function updateGlobalMcp(
  id: string,
  data: Partial<Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>>
): GlobalMcpServer {
  const now = Date.now()

  const updateValues: Partial<typeof globalMcpServers.$inferInsert> = {
    updatedAt: now,
  }

  if (data.name !== undefined) updateValues.name = data.name
  if (data.serverKey !== undefined) updateValues.serverKey = data.serverKey
  if (data.serverConfig !== undefined) updateValues.serverConfig = JSON.stringify(data.serverConfig)
  if (data.enabled !== undefined) updateValues.enabled = data.enabled ? 1 : 0

  drizzleDb.update(globalMcpServers).set(updateValues).where(eq(globalMcpServers.id, id)).run()

  const rows = drizzleDb.select().from(globalMcpServers).where(eq(globalMcpServers.id, id)).all()
  if (rows.length === 0) throw new Error(`Global MCP server with id ${id} not found after update`)
  return rowToGlobalMcpServer(rows[0])
}

export function deleteGlobalMcp(id: string): void {
  deleteSharesForEntity('globalMcpServer', id)
  drizzleDb.delete(globalMcpServers).where(eq(globalMcpServers.id, id)).run()
}
