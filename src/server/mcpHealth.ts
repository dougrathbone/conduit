// src/server/mcpHealth.ts
import type { McpHealthResult } from '../shared/types'

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
