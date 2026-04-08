import { ipcMain, BrowserWindow } from 'electron'
import { getAgent } from '../db/queries/agents'
import { getToken, saveToken, deleteToken } from '../db/queries/oauthTokens'
import { listGlobalMcps } from '../db/queries/globalMcps'
import { startOAuthFlow } from '../services/oauth'
import type { OAuthToken, McpOAuthConfig, McpServerEntry } from '../../shared/types'

/**
 * Resolve an MCP server entry from a serverId string.
 *
 * - isGlobal=true:  serverId is the GlobalMcpServer.id
 * - isGlobal=false: serverId is "{agentId}:{serverKey}"
 *
 * Returns the resolved [serverUrl, oauthConfig] or throws.
 */
function resolveServerEntry(
  serverId: string,
  isGlobal: boolean
): { serverUrl: string; oauthConfig: McpOAuthConfig; entry: McpServerEntry } {
  if (isGlobal) {
    const globals = listGlobalMcps()
    const found = globals.find((g) => g.id === serverId)
    if (!found) {
      throw new Error(`Global MCP server not found: ${serverId}`)
    }
    const entry = found.serverConfig
    if (!entry.url) {
      throw new Error(`Global MCP server "${found.name}" does not have a URL configured`)
    }
    if (!entry.oauth) {
      throw new Error(
        `Global MCP server "${found.name}" does not have OAuth configuration. ` +
          `Add an "oauth" block with clientId and scopes to its server config.`
      )
    }
    return { serverUrl: entry.url, oauthConfig: entry.oauth, entry }
  } else {
    // Agent MCP: serverId = "{agentId}:{serverKey}"
    const colonIndex = serverId.indexOf(':')
    if (colonIndex === -1) {
      throw new Error(
        `Invalid agent MCP serverId format: "${serverId}". Expected "{agentId}:{serverKey}"`
      )
    }
    const agentId = serverId.slice(0, colonIndex)
    const serverKey = serverId.slice(colonIndex + 1)

    const agent = getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const entry = agent.mcpConfig?.mcpServers?.[serverKey]
    if (!entry) {
      throw new Error(`MCP server key "${serverKey}" not found in agent "${agent.name}"`)
    }
    if (!entry.url) {
      throw new Error(
        `MCP server "${serverKey}" in agent "${agent.name}" does not have a URL configured`
      )
    }
    if (!entry.oauth) {
      throw new Error(
        `MCP server "${serverKey}" in agent "${agent.name}" does not have OAuth configuration. ` +
          `Add an "oauth" block with clientId and scopes to the server config.`
      )
    }
    return { serverUrl: entry.url, oauthConfig: entry.oauth, entry }
  }
}

export function registerMcpOAuthHandlers(mainWindow: BrowserWindow): void {
  // Return stored OAuth token for a server URL (or null)
  ipcMain.handle('mcp:oauth:getToken', (_event, serverUrl: string): OAuthToken | null => {
    return getToken(serverUrl)
  })

  // Revoke (delete) the stored OAuth token for a server URL
  ipcMain.handle('mcp:oauth:revokeToken', (_event, serverUrl: string): void => {
    deleteToken(serverUrl)
  })

  // Start the browser-based OAuth flow
  ipcMain.handle(
    'mcp:oauth:startAuth',
    async (_event, serverId: string, isGlobal: boolean): Promise<void> => {
      let serverUrl: string

      try {
        const resolved = resolveServerEntry(serverId, isGlobal)
        serverUrl = resolved.serverUrl

        await startOAuthFlow(serverUrl, resolved.oauthConfig, (token: OAuthToken | null, error?: string) => {
          if (token) {
            saveToken(token)
          }
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('mcp:oauth:complete', {
              serverUrl: token?.serverUrl ?? serverUrl,
              success: !!token,
              error,
            })
          }
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mcp:oauth:complete', {
            serverUrl: serverId,
            success: false,
            error: message,
          })
        }
        throw err
      }
    }
  )
}
