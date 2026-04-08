import { shell } from 'electron'
import * as http from 'http'
import * as net from 'net'
import * as crypto from 'crypto'
import { URL } from 'url'
import type { McpOAuthConfig, OAuthToken } from '../../shared/types'

interface OAuthDiscovery {
  authorization_endpoint: string
  token_endpoint: string
}

/**
 * Attempt to discover OAuth endpoints from the server's well-known URLs.
 * Tries the OAuth Authorization Server metadata first, then OpenID Connect discovery.
 */
export async function discoverOAuthEndpoints(serverUrl: string): Promise<OAuthDiscovery> {
  const base = serverUrl.replace(/\/$/, '')

  const candidates = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ]

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) continue
      const data = (await res.json()) as Record<string, unknown>
      if (
        typeof data.authorization_endpoint === 'string' &&
        typeof data.token_endpoint === 'string'
      ) {
        return {
          authorization_endpoint: data.authorization_endpoint,
          token_endpoint: data.token_endpoint,
        }
      }
    } catch {
      // Try the next candidate
    }
  }

  throw new Error(
    `Could not discover OAuth endpoints for ${serverUrl}. ` +
      `Neither /.well-known/oauth-authorization-server nor /.well-known/openid-configuration ` +
      `returned valid authorization_endpoint and token_endpoint fields.`
  )
}

/**
 * Find a free TCP port, starting from startPort and incrementing until one is available.
 */
async function findFreePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    const free = await isPortFree(port)
    if (free) return port
  }
  throw new Error(`Could not find a free port in range ${startPort}–${startPort + 99}`)
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Start the browser-based OAuth 2.0 + PKCE authorization flow for an MCP server.
 *
 * Opens the system browser at the authorization URL and starts a local HTTP server
 * to receive the callback. Calls onComplete with the resulting token (or null + error).
 */
export async function startOAuthFlow(
  serverUrl: string,
  oauthConfig: McpOAuthConfig,
  onComplete: (token: OAuthToken | null, error?: string) => void
): Promise<void> {
  // 1. Generate PKCE code verifier and challenge
  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')

  // 2. Resolve endpoints — use overrides from config if provided, else discover
  let discovery: OAuthDiscovery
  if (oauthConfig.authorizationUrl && oauthConfig.tokenUrl) {
    discovery = {
      authorization_endpoint: oauthConfig.authorizationUrl,
      token_endpoint: oauthConfig.tokenUrl,
    }
  } else {
    discovery = await discoverOAuthEndpoints(serverUrl)
  }

  // 3. Start local callback server
  const callbackPort = await findFreePort(7890)
  const redirectUri = `http://localhost:${callbackPort}/callback`
  const state = crypto.randomBytes(16).toString('hex')

  let completed = false

  const callbackServer = http.createServer(async (req, res) => {
    if (!req.url) return

    let pathname: string
    try {
      pathname = new URL(req.url, `http://localhost:${callbackPort}`).pathname
    } catch {
      return
    }

    if (pathname !== '/callback') {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    // Parse query params
    const urlObj = new URL(req.url, `http://localhost:${callbackPort}`)
    const code = urlObj.searchParams.get('code')
    const returnedState = urlObj.searchParams.get('state')
    const error = urlObj.searchParams.get('error')
    const errorDescription = urlObj.searchParams.get('error_description')

    // Determine outcome
    const failed = !!error || returnedState !== state

    // Always respond to the browser first
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${failed ? 'Authentication failed' : 'Authenticated'} — Conduit</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #0f0f0f; color: #e5e5e5; }
    .card { text-align: center; padding: 2rem; max-width: 400px; }
    h2 { font-size: 1.5rem; margin-bottom: 0.5rem;
         color: ${failed ? '#f87171' : '#34d399'}; }
    p { color: #a1a1aa; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${failed ? 'Authentication failed' : 'Authenticated!'}</h2>
    <p>${failed ? (errorDescription ?? error ?? 'State mismatch — please try again.') : 'You can close this tab and return to Conduit.'}</p>
  </div>
</body>
</html>`)

    // Close server (only handle one request)
    if (completed) return
    completed = true
    callbackServer.close()

    if (failed) {
      onComplete(null, error ?? 'State mismatch')
      return
    }

    if (!code) {
      onComplete(null, 'No authorization code received')
      return
    }

    // 4. Exchange code for token
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: oauthConfig.clientId,
        code_verifier: codeVerifier,
      })

      const tokenRes = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(10000),
      })

      if (!tokenRes.ok) {
        const errText = await tokenRes.text()
        onComplete(null, `Token exchange failed (${tokenRes.status}): ${errText}`)
        return
      }

      const tokenData = (await tokenRes.json()) as Record<string, unknown>

      if (typeof tokenData.access_token !== 'string') {
        onComplete(null, 'Token response did not contain access_token')
        return
      }

      const token: OAuthToken = {
        serverUrl,
        accessToken: tokenData.access_token,
        refreshToken:
          typeof tokenData.refresh_token === 'string' ? tokenData.refresh_token : undefined,
        expiresAt:
          typeof tokenData.expires_in === 'number'
            ? Date.now() + tokenData.expires_in * 1000
            : undefined,
        tokenType: typeof tokenData.token_type === 'string' ? tokenData.token_type : 'Bearer',
        scope: typeof tokenData.scope === 'string' ? tokenData.scope : undefined,
      }

      onComplete(token)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      onComplete(null, `Token exchange error: ${message}`)
    }
  })

  callbackServer.listen(callbackPort, '127.0.0.1')

  // 5. Build authorization URL
  const authUrl = new URL(discovery.authorization_endpoint)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', oauthConfig.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', oauthConfig.scopes.join(' '))
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')

  // 6. Open browser
  await shell.openExternal(authUrl.toString())
}
