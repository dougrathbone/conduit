import { db } from '../index'
import { DEV_USER_ID } from '../../../server/auth/config'
import type { ShareableEntityType } from '../../../shared/types'

const TABLE_MAP: Record<ShareableEntityType, string> = {
  agent: 'agents',
  publishTarget: 'publish_targets',
  repository: 'repositories',
  globalMcpServer: 'global_mcp_servers',
}

export function getVisibleEntityIds(
  entityType: ShareableEntityType,
  userId: string,
  userGroupIds: string[]
): string[] {
  const table = TABLE_MAP[entityType]

  // Dev user sees everything
  if (userId === DEV_USER_ID) {
    const rows = db.prepare(`SELECT id FROM ${table}`).all() as { id: string }[]
    return rows.map(r => r.id)
  }

  // Build the UNION query for visibility
  const params: unknown[] = []
  const parts: string[] = []

  // 1. Entities owned by user
  parts.push(`SELECT id FROM ${table} WHERE owner_id = ?`)
  params.push(userId)

  // 2. Entities shared directly with user
  parts.push(`SELECT entity_id FROM shares WHERE entity_type = ? AND target_type = 'user' AND target_id = ?`)
  params.push(entityType, userId)

  // 3. Entities shared with any of the user's groups
  if (userGroupIds.length > 0) {
    const placeholders = userGroupIds.map(() => '?').join(', ')
    parts.push(`SELECT entity_id FROM shares WHERE entity_type = ? AND target_type = 'group' AND target_id IN (${placeholders})`)
    params.push(entityType, ...userGroupIds)
  }

  // 4. Entities shared with everyone
  parts.push(`SELECT entity_id FROM shares WHERE entity_type = ? AND target_type = 'everyone'`)
  params.push(entityType)

  const sql = parts.join(' UNION ')
  const rows = db.prepare(sql).all(...params) as { id?: string; entity_id?: string }[]
  return rows.map(r => r.id ?? r.entity_id!)
}

export function canAccessEntity(
  entityType: ShareableEntityType,
  entityId: string,
  userId: string,
  userGroupIds: string[]
): boolean {
  if (userId === DEV_USER_ID) return true

  const table = TABLE_MAP[entityType]
  const params: unknown[] = []
  const parts: string[] = []

  // 1. Owned by user
  parts.push(`SELECT id AS eid FROM ${table} WHERE id = ? AND owner_id = ?`)
  params.push(entityId, userId)

  // 2. Shared directly with user
  parts.push(`SELECT entity_id AS eid FROM shares WHERE entity_type = ? AND entity_id = ? AND target_type = 'user' AND target_id = ?`)
  params.push(entityType, entityId, userId)

  // 3. Shared with any of the user's groups
  if (userGroupIds.length > 0) {
    const placeholders = userGroupIds.map(() => '?').join(', ')
    parts.push(`SELECT entity_id AS eid FROM shares WHERE entity_type = ? AND entity_id = ? AND target_type = 'group' AND target_id IN (${placeholders})`)
    params.push(entityType, entityId, ...userGroupIds)
  }

  // 4. Shared with everyone
  parts.push(`SELECT entity_id AS eid FROM shares WHERE entity_type = ? AND entity_id = ? AND target_type = 'everyone'`)
  params.push(entityType, entityId)

  // Check if any matching row exists via COUNT on the union subquery
  const unionSql = parts.join(' UNION ')
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM (${unionSql}) sub`).get(...params) as { cnt: number }
  return row.cnt > 0
}

export function isEntityOwner(
  entityType: ShareableEntityType,
  entityId: string,
  userId: string
): boolean {
  const table = TABLE_MAP[entityType]
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND owner_id = ?`).get(entityId, userId) as { id: string } | undefined
  return !!row
}
