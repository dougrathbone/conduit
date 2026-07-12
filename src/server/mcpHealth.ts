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
