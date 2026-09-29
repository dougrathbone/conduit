// src/server/mcpHealth.ts
import { execFileSync } from 'child_process'
import { isUrlMcpServer } from '../shared/mcp'
import type { McpHealthResult, McpServerEntry } from '../shared/types'

/**
 * Map an HTTP response status from a reachable MCP URL to a health result.
 * 401/403 mean the endpoint is up but requires authentication.
 */
export function classifyUrlHealth(status: number, statusText: string): McpHealthResult {
  if (status === 401 || status === 403) {
    return { status: 'unauthorized', message: `HTTP ${status} ${statusText}` }
  }
  // 405/406 mean the endpoint is up and past auth but declined the probe's
  // method/Accept (e.g. a streamable-HTTP MCP server that only speaks POST). It's
  // still reachable and authenticated — report healthy without the misleading
  // "Method Not Allowed"/"Not Acceptable" text.
  if (status === 405 || status === 406) {
    return { status: 'healthy', message: 'Reachable' }
  }
  return { status: 'healthy', message: `HTTP ${status} ${statusText}` }
}

/**
 * Build the headers for the MCP `initialize` health probe.
 *
 * Carries the user's own `config.headers` through — so a manually supplied
 * `Authorization: Bearer …` (e.g. a Datadog PAT) is actually sent and the probe
 * reflects real auth instead of always 401ing — while forcing the JSON-RPC
 * content type and the streamable-HTTP `Accept` the probe requires. A resolved
 * OAuth token, when present, overrides any manual header — matching the
 * precedence of runtime injection (`injectOAuthTokens`) and the `listTools`
 * handler, both of which spread `headers` then set `Authorization` from the token.
 */
export function buildHealthProbeHeaders(
  configHeaders: Record<string, string> | undefined,
  authOverride?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    ...configHeaders,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (authOverride) headers.Authorization = authOverride
  return headers
}

/**
 * Probe one MCP server the same way the Global MCPs health dot does: a
 * streamable-HTTP `initialize` for URL servers, `which` for stdio commands.
 */
export async function probeMcpServerHealth(config: McpServerEntry): Promise<McpHealthResult> {
  if (isUrlMcpServer(config) && config.url) {
    try {
      // Probe with a real MCP `initialize` handshake, not a bare GET. Streamable-
      // HTTP MCP servers (Linear/Sentry/Figma/…) reject a bare GET or `Accept: */*`
      // with 405 Method Not Allowed / 406 Not Acceptable — so once a valid token
      // gets past the 401, the probe would surface a misleading "Method Not
      // Allowed". A POST initialize with the streamable-HTTP Accept header is what
      // an actual MCP client sends: 200 when authenticated + usable, 401 when not.
      // Carry the user's own headers (a manual `Authorization: Bearer …`, or
      // Datadog-style DD-API-KEY headers) so the probe reflects real auth. A
      // resolved global OAuth token, when present, still overrides — matching
      // runtime injection precedence. Without this, a manually-authed server
      // always 401s here, reads as `unauthorized`, and wrongly kicks OAuth.
      let authOverride: string | undefined
      try {
        const { resolveGlobalMcpToken } = await import('../main/utils/mcp')
        const { normalizeTokenScheme } = await import('./mcpOAuth/flow')
        const token = await resolveGlobalMcpToken(config.url)
        if (token) authOverride = `${normalizeTokenScheme(token.tokenType)} ${token.accessToken}`
      } catch {
        // No token resolvable — fall through to the config's own headers.
      }
      const headers = buildHealthProbeHeaders(config.headers, authOverride)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 4000)
      const res = await fetch(config.url, {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'conduit-healthcheck', version: '1' },
          },
        }),
      })
      clearTimeout(timeout)
      return classifyUrlHealth(res.status, res.statusText)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed'
      return { status: 'unhealthy', message: msg }
    }
  }

  const command = config.command ?? ''
  if (!command) return { status: 'unhealthy', message: 'No command configured' }

  try {
    // execFile (not exec) avoids shell interpretation of `command`.
    execFileSync('which', [command], { stdio: 'ignore' })
    return { status: 'healthy', message: `${command} found in PATH` }
  } catch {
    return { status: 'unhealthy', message: `${command} not found in PATH` }
  }
}
