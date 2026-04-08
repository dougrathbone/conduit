import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { McpServersConfig, McpServerEntry } from '../../shared/types'
import { listEnabledGlobalMcps } from '../db/queries/globalMcps'
import { getToken } from '../db/queries/oauthTokens'

/**
 * Merges global MCP servers with agent-specific MCP config.
 * Global MCPs form the base layer; agent MCPs override on key conflict.
 */
export function buildMergedMcpConfig(agentMcpConfig: McpServersConfig): McpServersConfig {
  const globalMcps = listEnabledGlobalMcps()
  const globalServers: Record<string, McpServerEntry> = {}
  for (const g of globalMcps) {
    globalServers[g.serverKey] = g.serverConfig
  }
  return {
    mcpServers: {
      ...globalServers,
      ...agentMcpConfig.mcpServers,
    },
  }
}

/**
 * For each URL-type MCP server in the config, look up any stored OAuth token
 * and inject it as an Authorization header if it is still valid.
 */
export function injectOAuthTokens(config: McpServersConfig): McpServersConfig {
  const updated: Record<string, McpServerEntry> = {}
  for (const [key, entry] of Object.entries(config.mcpServers)) {
    if (entry.type === 'url' && entry.url) {
      const token = getToken(entry.url)
      if (token && (!token.expiresAt || token.expiresAt > Date.now())) {
        updated[key] = {
          ...entry,
          headers: {
            ...entry.headers,
            Authorization: `${token.tokenType} ${token.accessToken}`,
          },
        }
        continue
      }
    }
    updated[key] = entry
  }
  return { mcpServers: updated }
}

/**
 * Writes an MCP config JSON file to the OS temp directory.
 * Returns the path to the written file.
 */
export function writeMcpConfig(runId: string, config: McpServersConfig): string {
  const withTokens = injectOAuthTokens(config)
  const filePath = path.join(os.tmpdir(), `conduit-mcp-${runId}.json`)
  fs.writeFileSync(filePath, JSON.stringify(withTokens, null, 2), 'utf8')
  return filePath
}

/**
 * Deletes the MCP config file for a given run. Silently ignores errors.
 */
export function deleteMcpConfig(runId: string): void {
  const filePath = path.join(os.tmpdir(), `conduit-mcp-${runId}.json`)
  try {
    fs.unlinkSync(filePath)
  } catch {
    // Ignore — file may have already been deleted or never created
  }
}
