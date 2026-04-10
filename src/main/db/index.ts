import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { DB_PATH } from '../utils/paths'
import * as schema from './schema'

let db: Database.Database
let drizzleDb: ReturnType<typeof drizzle>

export function initDb(): void {
  db = new Database(DB_PATH)

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      runner TEXT NOT NULL,
      prompt TEXT NOT NULL,
      env_vars TEXT NOT NULL DEFAULT '{}',
      mcp_config TEXT NOT NULL DEFAULT '{"mcpServers":{}}',
      gist_id TEXT,
      working_dir TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      server_key TEXT NOT NULL,
      server_config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_ms INTEGER,
      workspace_path TEXT,
      log_path TEXT NOT NULL,
      exit_code INTEGER,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS publish_targets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'slack',
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_triggered_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      server_url TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER,
      token_type TEXT NOT NULL DEFAULT 'Bearer',
      scope TEXT
    );

    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      auth_method TEXT NOT NULL DEFAULT 'none',
      sync_status TEXT NOT NULL DEFAULT 'pending',
      sync_error TEXT,
      last_synced_at INTEGER,
      clone_path TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar_url TEXT,
      last_login_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_group_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_groups (
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      PRIMARY KEY (user_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS unique_share
      ON shares(entity_type, entity_id, target_type, target_id);
  `)

  // Migrations: add columns added after initial schema
  try { db.exec('ALTER TABLE agents ADD COLUMN working_dir TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE agents ADD COLUMN publish_target_ids TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE agents ADD COLUMN repository_id TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE runs ADD COLUMN trigger_context TEXT') } catch { /* already exists */ }

  // Multi-user: add ownership columns
  try { db.exec("ALTER TABLE agents ADD COLUMN owner_id TEXT DEFAULT 'dev-user'") } catch { /* already exists */ }
  try { db.exec("ALTER TABLE publish_targets ADD COLUMN owner_id TEXT DEFAULT 'dev-user'") } catch { /* already exists */ }
  try { db.exec("ALTER TABLE repositories ADD COLUMN owner_id TEXT DEFAULT 'dev-user'") } catch { /* already exists */ }
  try { db.exec("ALTER TABLE global_mcp_servers ADD COLUMN owner_id TEXT DEFAULT 'dev-user'") } catch { /* already exists */ }
  try { db.exec('ALTER TABLE runs ADD COLUMN started_by TEXT') } catch { /* already exists */ }

  drizzleDb = drizzle(db, { schema })
}

export { db, drizzleDb }
