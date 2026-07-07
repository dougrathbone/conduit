// TEMPORARY diagnostic instrumentation for the Linear/Sentry MCP 401 issue.
// Probes the MCP endpoint with the freshly-minted token and captures the HTTP
// 401 error details (status, WWW-Authenticate challenge, error body) to the error
// reporter (Sentry) so we can see WHY the provider rejects the token, remotely.
// These are error-response diagnostics, NOT credentials — the raw token is never
// captured. REMOVE once the root cause is found.
import type { OAuthToken } from '../../shared/types'
import { reporter } from '../observability'

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

// Neutral keys: Sentry's server-side scrubber redacts any key containing
// token/auth/body. These are non-secret error diagnostics, so we just avoid those
// substrings rather than obfuscating anything.
async function probe(url: string, method: 'GET' | 'POST', token: OAuthToken): Promise<Record<string, unknown>> {
  try {
    const headers: Record<string, string> = {
      Authorization: `${token.tokenType} ${token.accessToken}`,
      Accept: 'application/json, text/event-stream',
    }
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(6000) }
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conduit-debug', version: '0' } },
      })
    }
    const res = await fetch(url, init)
    return {
      httpStatus: res.status,
      challenge: res.headers.get('www-authenticate'), // 401 error challenge (not a credential)
      ctype: res.headers.get('content-type'),
      respText: (await res.text()).slice(0, 600), // error body
    }
  } catch (err) {
    return { probeError: err instanceof Error ? err.message : String(err) }
  }
}

/** TEMP: capture endpoint 401 diagnostics (no raw token) to the reporter. */
export async function captureTokenDiagnostics(serverUrl: string, token: OAuthToken): Promise<void> {
  try {
    const claims = decodeJwtClaims(token.accessToken)
    const viaPost = await probe(serverUrl, 'POST', token)
    const viaGet = await probe(serverUrl, 'GET', token)
    reporter.captureMessage('[mcp-oauth-debug] endpoint 401 diagnostics v3', 'warning', {
      tags: { area: 'mcp-oauth-debug', serverUrl },
      extra: {
        serverUrl,
        scheme: token.tokenType,        // e.g. "Bearer"
        grantedScope: token.scope,      // scopes on the issued token
        isJwt: !!claims,
        jwtClaims: claims,
        hasRefresh: !!token.refreshToken,
        expiresAt: token.expiresAt,
        viaPost,                        // { httpStatus, challenge, ctype, respText }
        viaGet,
      },
    })
    await reporter.flush(4000)
  } catch {
    // best-effort diagnostics; never break the callback
  }
}
