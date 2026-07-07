// Structured audit trail for the MCP OAuth lifecycle.
//
// Emitted to stdout as single-line, greppable records so the platform log
// pipeline (CloudWatch) retains a trail of who connected / reset which MCP
// server and how the DCR client + token flow resolved. This is what lets us
// reconstruct "why did this reconnect fail" without a live repro.
//
// NEVER pass access/refresh tokens, client secrets, PKCE verifiers, or auth
// codes — only non-secret identifiers (userId, serverUrl, clientId, redirectUri,
// outcome, error message).
export function auditMcpOAuth(event: string, fields: Record<string, unknown> = {}): void {
  let detail = ''
  try {
    detail = JSON.stringify(fields)
  } catch {
    detail = '{}'
  }
  console.info(`[mcp-oauth] ${event} ${detail}`)
}
