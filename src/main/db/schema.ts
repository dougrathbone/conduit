import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

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
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const globalMcpServers = sqliteTable('global_mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  serverKey: text('server_key').notNull(),
  serverConfig: text('server_config').notNull(),
  enabled: integer('enabled').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const publishTargets = sqliteTable('publish_targets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull().default('slack'),
  config: text('config').notNull().default('{}'),
  enabled: integer('enabled').notNull().default(1),
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
})
