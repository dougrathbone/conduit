import { log } from '../logging'

// Structured audit trail for the MCP OAuth lifecycle.
//
// Emitted as JSON log records (stdout, and OTLP when configured) so the
// platform log pipeline retains who connected / reset which MCP server and how
// the DCR client + token flow resolved. This is what lets us reconstruct
// "why did this reconnect fail" without a live repro.
//
// NEVER pass access/refresh tokens, client secrets, PKCE verifiers, or auth
// codes — only non-secret identifiers (userId, serverUrl, clientId, redirectUri,
// outcome, error message).
export function auditMcpOAuth(event: string, fields: Record<string, unknown> = {}): void {
  log.info(event, { component: 'mcp-oauth', ...fields })
}
