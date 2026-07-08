import { eq, lt } from 'drizzle-orm'
import { getDb } from '../index'
import { sessions } from '../schema'
import { encryptSecret, decryptSecret } from '../../../server/crypto'

// Session access/refresh tokens are encrypted at rest with CONDUIT_SECRET_KEY
// (same as MCP OAuth tokens and GitHub App keys). Decrypt tolerantly: a value
// that isn't a valid ciphertext is a legacy pre-encryption row, so return it
// as-is (it is re-encrypted on the next token refresh) instead of throwing.
let warnedDecryptFailure = false
function safeDecrypt<T extends string | null>(value: T): T {
  if (value === null) return value
  try {
    return decryptSecret(value) as T
  } catch {
    // A legacy plaintext row is expected and benign. But a value that IS shaped
    // like a ciphertext blob (iv:authTag:ciphertext) yet fails to decrypt points
    // at a wrong/rotated CONDUIT_SECRET_KEY or corruption — warn once so it isn't
    // silently mistaken for legacy data (those sessions just fail to refresh and
    // the user re-logs-in, but ops should know the key is off).
    if (!warnedDecryptFailure && /^[^:]+:[^:]+:[^:]+$/.test(value)) {
      warnedDecryptFailure = true
      console.warn(
        '[auth] A session token is ciphertext-shaped but could not be decrypted — ' +
          'check CONDUIT_SECRET_KEY (wrong or rotated key?). Affected sessions will require re-login.'
      )
    }
    return value
  }
}

export async function createSession(data: {
  userId: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
}) {
  const id = crypto.randomUUID()
  const now = Date.now()

  await getDb().insert(sessions).values({
    id,
    userId: data.userId,
    accessToken: encryptSecret(data.accessToken),
    refreshToken: data.refreshToken ? encryptSecret(data.refreshToken) : null,
    expiresAt: data.expiresAt,
    createdAt: now,
  })

  const rows = await getDb().select().from(sessions).where(eq(sessions.id, id))
  const row = rows[0]
  if (!row) throw new Error(`Failed to create session with id ${id}`)
  // Return decrypted tokens, consistent with getSession, so callers never see
  // ciphertext off the return value.
  return {
    ...row,
    accessToken: safeDecrypt(row.accessToken),
    refreshToken: safeDecrypt(row.refreshToken),
  }
}

// Raw read of a session row by id. This is intentionally policy-free: expiry
// enforcement AND refresh live in resolveSession (src/server/auth/session.ts),
// the single source of truth all consumers go through. Keeping this raw means
// the row (and its refresh token) is still available to renew an expired
// session, instead of being purged before it can be refreshed.
export async function getSession(id: string) {
  const rows = await getDb().select().from(sessions).where(eq(sessions.id, id))
  const row = rows[0]
  if (!row) return null
  return {
    ...row,
    accessToken: safeDecrypt(row.accessToken),
    refreshToken: safeDecrypt(row.refreshToken),
  }
}

export async function deleteSession(id: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.id, id))
}

export async function deleteExpiredSessions(): Promise<number> {
  const now = Date.now()
  const deleted = await getDb()
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id })
  return deleted.length
}

export async function updateSessionTokens(
  id: string,
  data: { accessToken: string; refreshToken?: string; expiresAt: number }
): Promise<void> {
  await getDb().update(sessions).set({
    accessToken: encryptSecret(data.accessToken),
    refreshToken: data.refreshToken ? encryptSecret(data.refreshToken) : null,
    expiresAt: data.expiresAt,
  }).where(eq(sessions.id, id))
}
