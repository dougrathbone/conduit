import { sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core'

// ── Auth & Users ───────────────────────────────────────────────────────────

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  lastLoginAt: integer('last_login_at').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentGroupId: text('parent_group_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const userGroups = sqliteTable('user_groups', {
  userId: text('user_id').notNull(),
  groupId: text('group_id').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.groupId] }),
}))

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const shares = sqliteTable('shares', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  uniqueShare: uniqueIndex('unique_share').on(table.entityType, table.entityId, table.targetType, table.targetId),
}))

// ── Existing Tables ────────────────────────────────────────────────────────

export const oauthTokens = sqliteTable('oauth_tokens', {
  serverUrl: text('server_url').primaryKey(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt: integer('expires_at'),
  tokenType: text('token_type').notNull().default('Bearer'),
  scope: text('scope'),
})

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  runner: text('runner').notNull(),
  prompt: text('prompt').notNull(),
  envVars: text('env_vars').notNull().default('{}'),
  mcpConfig: text('mcp_config').notNull().default('{"mcpServers":{}}'),
  gistId: text('gist_id'),
  workingDir: text('working_dir'),
  publishTargetIds: text('publish_target_ids'),
  repositoryId: text('repository_id'),
  ownerId: text('owner_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const globalMcpServers = sqliteTable('global_mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  serverKey: text('server_key').notNull(),
  serverConfig: text('server_config').notNull(),
  enabled: integer('enabled').notNull().default(1),
  ownerId: text('owner_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const publishTargets = sqliteTable('publish_targets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull().default('slack'),
  config: text('config').notNull().default('{}'),
  enabled: integer('enabled').notNull().default(1),
  ownerId: text('owner_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  authMethod: text('auth_method').notNull().default('none'),
  syncStatus: text('sync_status').notNull().default('pending'),
  syncError: text('sync_error'),
  lastSyncedAt: integer('last_synced_at'),
  clonePath: text('clone_path'),
  ownerId: text('owner_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const triggers = sqliteTable('triggers', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  name: text('name').notNull(),
  type: text('type').notNull(),
  config: text('config').notNull().default('{}'),
  enabled: integer('enabled').notNull().default(1),
  lastTriggeredAt: integer('last_triggered_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  status: text('status').notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  durationMs: integer('duration_ms'),
  workspacePath: text('workspace_path'),
  logPath: text('log_path').notNull(),
  exitCode: integer('exit_code'),
  triggerContext: text('trigger_context'),
  startedBy: text('started_by'),
})
