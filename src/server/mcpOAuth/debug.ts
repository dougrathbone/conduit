// TEMPORARY diagnostic instrumentation for the Linear/Sentry MCP 401 issue.
// Captures token claims + live probe results of the MCP endpoint to the error
// reporter (Sentry) so we can diagnose remotely. REMOVE once the 401 root cause
// is found, and revoke any tokens whose details were captured.
import type { OAuthToken } from '../../shared/types'
import { reporter } from '../observability'

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    return null
  }
}

async function probe(
  url: string,
  method: 'GET' | 'POST',
  token: OAuthToken
): Promise<Record<string, unknown>> {
  try {
    const headers: Record<string, string> = {
      Authorization: `${token.tokenType} ${token.accessToken}`,
      Accept: 'application/json, text/event-stream',
    }
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(6000) }
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'conduit-debug', version: '0' },
        },
      })
    }
    const res = await fetch(url, init)
    const body = (await res.text()).slice(0, 600)
    return {
      status: res.status,
      wwwAuthenticate: res.headers.get('www-authenticate'),
      contentType: res.headers.get('content-type'),
      body,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** TEMP: capture token claims + endpoint probe results to the reporter. */
export async function captureTokenDiagnostics(serverUrl: string, token: OAuthToken): Promise<void> {
  try {
    const claims = decodeJwtClaims(token.accessToken)
    const probePost = await probe(serverUrl, 'POST', token)
    const probeGet = await probe(serverUrl, 'GET', token)
    reporter.captureMessage('[mcp-oauth-debug] token diagnostics', 'warning', {
      tags: { area: 'mcp-oauth-debug', serverUrl },
      extra: {
        serverUrl,
        tokenType: token.tokenType,
        scope: token.scope,
        hasRefresh: !!token.refreshToken,
        expiresAt: token.expiresAt,
        accessTokenPrefix: token.accessToken.slice(0, 10),
        accessTokenLen: token.accessToken.length,
        accessTokenIsJwt: !!claims,
        jwtClaims: claims,
        probePost,
        probeGet,
      },
    })
    await reporter.flush(4000)
  } catch {
    // best-effort diagnostics; never break the callback
  }
}
