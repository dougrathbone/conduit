import type { McpServerEntry } from './types'

/**
 * Whether an MCP server is URL-based (a remote server reached over HTTP/SSE)
 * rather than a local stdio process.
 *
 * A server is URL-based when it carries a `url` and its transport isn't stdio.
 * This tolerates the various remote transport labels clients emit ('url',
 * 'http', 'streamable-http', 'sse') — historically the code compared strictly
 * to `type === 'url'`, which silently excluded 'http' servers from OAuth and
 * token injection even though the health check treated them as remote.
 */
export function isUrlMcpServer(cfg: McpServerEntry | undefined): boolean {
  return !!cfg && !!cfg.url && cfg.type !== 'stdio'
}

/**
 * Whether the config carries a user-supplied `Authorization` header. Header
 * names are case-insensitive, so this matches `Authorization`, `authorization`,
 * etc., and ignores blank values.
 *
 * When present, the user has opted into manual auth for this server, so Conduit
 * must NOT auto-initiate its managed OAuth flow — it should send that header on
 * health checks and at run time instead. This is the signal that lets a config
 * like Datadog's `{ headers: { Authorization: "Bearer …" } }` sidestep OAuth.
 */
export function hasManualAuthHeader(cfg: McpServerEntry | undefined): boolean {
  if (!cfg?.headers) return false
  return Object.entries(cfg.headers).some(
    ([name, value]) => name.toLowerCase() === 'authorization' && typeof value === 'string' && value.trim() !== ''
  )
}
