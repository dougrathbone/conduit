import { getOktaConfig } from './config'
import { refreshTokens } from './okta'
import {
  getSession,
  updateSessionTokens,
  deleteSession,
} from '../../main/db/queries/sessions'

type SessionRow = NonNullable<Awaited<ReturnType<typeof getSession>>>

// Renew a session this many ms *before* its access token actually expires, so an
// active user's session is refreshed ahead of time and there is no window where
// requests race a just-expired token.
const REFRESH_SKEW_MS = 60_000

// Serialises concurrent refreshes of the same session. Providers that rotate
// refresh tokens (Okta with rotation on) invalidate the old token once it is
// used — so two racing refreshes would make the second fail and needlessly log
// the user out. Callers within the skew window share one in-flight refresh.
const refreshLocks = new Map<string, Promise<SessionRow | null>>()

/**
 * The single source of truth for "is this session still good?".
 *
 * All consumers (REST middleware, GET /auth/me, the WebSocket upgrade and the
 * live-connection re-validation) go through here so behaviour is identical
 * everywhere:
 *   - comfortably valid  -> returned as-is
 *   - at/near/past expiry -> renewed via the Okta refresh token and returned
 *   - refresh impossible and genuinely expired -> deleted, returns null
 *
 * Only call this when auth is enabled; in dev-bypass mode consumers short-circuit
 * to the dev context and never touch sessions.
 */
export async function resolveSession(sessionId: string): Promise<SessionRow | null> {
  const session = await getSession(sessionId)
  if (!session) return null

  // Comfortably valid — nothing to do.
  if (session.expiresAt - Date.now() > REFRESH_SKEW_MS) return session

  // Needs renewal — dedupe concurrent attempts for this session.
  let lock = refreshLocks.get(sessionId)
  if (!lock) {
    lock = renewSession(session).finally(() => refreshLocks.delete(sessionId))
    refreshLocks.set(sessionId, lock)
  }
  return lock
}

async function renewSession(session: SessionRow): Promise<SessionRow | null> {
  if (session.refreshToken) {
    try {
      const refreshed = await refreshTokens(session.refreshToken)
      const expiresAt =
        Date.now() +
        (refreshed.expiresIn ? refreshed.expiresIn * 1000 : getOktaConfig().sessionTtlMs)
      const refreshToken = refreshed.refreshToken ?? session.refreshToken
      await updateSessionTokens(session.id, {
        accessToken: refreshed.accessToken,
        refreshToken,
        expiresAt,
      })
      return { ...session, accessToken: refreshed.accessToken, refreshToken, expiresAt }
    } catch (err) {
      // Only a definitively-rejected refresh token (invalid_grant) means the
      // session is dead — delete it. A transient failure (Okta 5xx / unreachable,
      // or the OIDC client not yet initialised at boot) must NOT destroy the
      // session: we leave the row intact so a later attempt can still refresh it
      // (the hourly sweep reclaims it if it never recovers).
      if (isDeadRefreshToken(err)) {
        await purge(session.id)
        return null
      }
    }
  } else if (session.expiresAt < Date.now()) {
    // No refresh token and genuinely expired — nothing can revive it.
    await purge(session.id)
    return null
  }

  // Still valid within the skew window — keep serving until it actually expires.
  if (session.expiresAt >= Date.now()) return session

  // Expired, but the refresh failure was transient — return null (we cannot serve
  // an expired token) WITHOUT deleting, so a later attempt can still recover it.
  return null
}

// Best-effort delete — a failed cleanup write must not throw; the hourly sweep
// reclaims the row regardless.
async function purge(id: string): Promise<void> {
  try {
    await deleteSession(id)
  } catch {
    // ignore
  }
}

// A refresh token is only "dead" when the provider explicitly rejects it
// (invalid_grant / invalid_token). Every other failure — network, 5xx, or the
// OIDC client not being initialised — is treated as transient so we never
// destroy a recoverable session on a blip.
function isDeadRefreshToken(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { error?: unknown; code?: unknown }).error
    ?? (err as { code?: unknown }).code
  return code === 'invalid_grant' || code === 'invalid_token'
}
