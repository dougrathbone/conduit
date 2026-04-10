import { eq, desc } from 'drizzle-orm'
import { drizzleDb } from '../index'
import { runs } from '../schema'
import type { ExecutionRun, RunStatus, TriggerContext } from '../../../shared/types'

function rowToExecutionRun(row: typeof runs.$inferSelect): ExecutionRun {
  return {
    id: row.id,
    agentId: row.agentId,
    status: row.status as RunStatus,
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? undefined,
    durationMs: row.durationMs ?? undefined,
    workspacePath: row.workspacePath ?? undefined,
    logPath: row.logPath,
    exitCode: row.exitCode ?? undefined,
    triggerContext: row.triggerContext ? JSON.parse(row.triggerContext) as TriggerContext : undefined,
    startedBy: row.startedBy ?? undefined,
  }
}

export function listRuns(agentId: string): ExecutionRun[] {
  const rows = drizzleDb
    .select()
    .from(runs)
    .where(eq(runs.agentId, agentId))
    .orderBy(desc(runs.startedAt))
    .all()
  return rows.map(rowToExecutionRun)
}

export function getRun(id: string): ExecutionRun | null {
  const rows = drizzleDb.select().from(runs).where(eq(runs.id, id)).all()
  if (rows.length === 0) return null
  return rowToExecutionRun(rows[0])
}

export function createRun(
  data: Omit<ExecutionRun, 'id'>
): ExecutionRun {
  const id = crypto.randomUUID()

  drizzleDb.insert(runs).values({
    id,
    agentId: data.agentId,
    status: data.status,
    startedAt: data.startedAt,
    endedAt: data.endedAt ?? null,
    durationMs: data.durationMs ?? null,
    workspacePath: data.workspacePath ?? null,
    logPath: data.logPath,
    exitCode: data.exitCode ?? null,
    triggerContext: data.triggerContext ? JSON.stringify(data.triggerContext) : null,
    startedBy: data.startedBy ?? null,
  }).run()

  const created = getRun(id)
  if (!created) throw new Error(`Failed to create run with id ${id}`)
  return created
}

export function updateRun(
  id: string,
  data: Partial<Omit<ExecutionRun, 'id'>>
): ExecutionRun {
  const updateValues: Partial<typeof runs.$inferInsert> = {}

  if (data.agentId !== undefined) updateValues.agentId = data.agentId
  if (data.status !== undefined) updateValues.status = data.status
  if (data.startedAt !== undefined) updateValues.startedAt = data.startedAt
  if ('endedAt' in data) updateValues.endedAt = data.endedAt ?? null
  if ('durationMs' in data) updateValues.durationMs = data.durationMs ?? null
  if ('workspacePath' in data) updateValues.workspacePath = data.workspacePath ?? null
  if (data.logPath !== undefined) updateValues.logPath = data.logPath
  if ('exitCode' in data) updateValues.exitCode = data.exitCode ?? null

  drizzleDb.update(runs).set(updateValues).where(eq(runs.id, id)).run()

  const updated = getRun(id)
  if (!updated) throw new Error(`Run with id ${id} not found after update`)
  return updated
}

export function getOrphanedRuns(): ExecutionRun[] {
  const rows = drizzleDb
    .select()
    .from(runs)
    .where(eq(runs.status, 'running'))
    .all()
  return rows.map(rowToExecutionRun)
}
