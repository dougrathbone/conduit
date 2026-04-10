import { getOktaConfig, isAuthEnabled } from './config'

// openid-client v6 is ESM-only, so we must use dynamic import
type OpenIDClient = typeof import('openid-client')
let clientModule: OpenIDClient | null = null
let oidcConfig: import('openid-client').Configuration | null = null

async function getClient(): Promise<OpenIDClient> {
  if (!clientModule) {
    clientModule = await import('openid-client')
  }
  return clientModule
}

export async function initOidcClient(): Promise<void> {
  if (!isAuthEnabled()) return

  const client = await getClient()
  const { issuer, clientId, clientSecret } = getOktaConfig()

  oidcConfig = await client.discovery(
    new URL(issuer),
    clientId,
    clientSecret
  )

  console.log('[auth] OIDC client initialized for issuer:', issuer)
}

export async function getAuthorizationUrl(): Promise<{
  url: URL
  codeVerifier: string
  state: string
}> {
  if (!oidcConfig) throw new Error('OIDC client not initialized')

  const client = await getClient()
  const { redirectUri } = getOktaConfig()

  const codeVerifier = client.randomPKCECodeVerifier()
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
  const state = crypto.randomUUID()

  const url = client.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: redirectUri,
    scope: 'openid profile email groups',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  })

  return { url, codeVerifier, state }
}

export async function exchangeCode(
  callbackUrl: URL,
  codeVerifier: string,
  expectedState: string
): Promise<{
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  claims: Record<string, unknown>
}> {
  if (!oidcConfig) throw new Error('OIDC client not initialized')

  const client = await getClient()

  const tokenResponse = await client.authorizationCodeGrant(
    oidcConfig,
    callbackUrl,
    {
      pkceCodeVerifier: codeVerifier,
      expectedState,
    }
  )

  const claims = tokenResponse.claims() ?? {}

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresIn: tokenResponse.expires_in,
    claims: claims as Record<string, unknown>,
  }
}

export async function refreshTokens(refreshToken: string): Promise<{
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}> {
  if (!oidcConfig) throw new Error('OIDC client not initialized')

  const client = await getClient()

  const tokenResponse = await client.refreshTokenGrant(oidcConfig, refreshToken)

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresIn: tokenResponse.expires_in,
  }
}
