import { eq } from 'drizzle-orm'
import { drizzleDb } from '../index'
import { agents } from '../schema'
import type { AgentConfig, McpServersConfig } from '../../../shared/types'

function rowToAgentConfig(row: typeof agents.$inferSelect): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    runner: row.runner as AgentConfig['runner'],
    prompt: row.prompt,
    envVars: JSON.parse(row.envVars ?? '{}') as Record<string, string>,
    mcpConfig: JSON.parse(row.mcpConfig ?? '{"mcpServers":{}}') as McpServersConfig,
    gistId: row.gistId ?? undefined,
    workingDir: row.workingDir ?? undefined,
    publishTargetIds: row.publishTargetIds ? JSON.parse(row.publishTargetIds) as string[] : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function listAgents(): AgentConfig[] {
  const rows = drizzleDb.select().from(agents).all()
  return rows.map(rowToAgentConfig)
}

export function getAgent(id: string): AgentConfig | null {
  const rows = drizzleDb.select().from(agents).where(eq(agents.id, id)).all()
  if (rows.length === 0) return null
  return rowToAgentConfig(rows[0])
}

export function createAgent(
  data: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>
): AgentConfig {
  const now = Date.now()
  const id = crypto.randomUUID()

  drizzleDb.insert(agents).values({
    id,
    name: data.name,
    runner: data.runner,
    prompt: data.prompt,
    envVars: JSON.stringify(data.envVars ?? {}),
    mcpConfig: JSON.stringify(data.mcpConfig ?? { mcpServers: {} }),
    gistId: data.gistId ?? null,
    workingDir: data.workingDir ?? null,
    publishTargetIds: data.publishTargetIds ? JSON.stringify(data.publishTargetIds) : null,
    createdAt: now,
    updatedAt: now,
  }).run()

  const created = getAgent(id)
  if (!created) throw new Error(`Failed to create agent with id ${id}`)
  return created
}

export function updateAgent(
  id: string,
  data: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>
): AgentConfig {
  const now = Date.now()

  const updateValues: Partial<typeof agents.$inferInsert> = {
    updatedAt: now,
  }

  if (data.name !== undefined) updateValues.name = data.name
  if (data.runner !== undefined) updateValues.runner = data.runner
  if (data.prompt !== undefined) updateValues.prompt = data.prompt
  if (data.envVars !== undefined) updateValues.envVars = JSON.stringify(data.envVars)
  if (data.mcpConfig !== undefined) updateValues.mcpConfig = JSON.stringify(data.mcpConfig)
  if ('gistId' in data) updateValues.gistId = data.gistId ?? null
  if ('workingDir' in data) updateValues.workingDir = data.workingDir ?? null
  if ('publishTargetIds' in data) updateValues.publishTargetIds = data.publishTargetIds ? JSON.stringify(data.publishTargetIds) : null

  drizzleDb.update(agents).set(updateValues).where(eq(agents.id, id)).run()

  const updated = getAgent(id)
  if (!updated) throw new Error(`Agent with id ${id} not found after update`)
  return updated
}

export function deleteAgent(id: string): void {
  drizzleDb.delete(agents).where(eq(agents.id, id)).run()
}
