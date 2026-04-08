import { eq } from 'drizzle-orm'
import { drizzleDb } from '../index'
import { oauthTokens } from '../schema'
import type { OAuthToken } from '../../../shared/types'

function rowToOAuthToken(row: typeof oauthTokens.$inferSelect): OAuthToken {
  return {
    serverUrl: row.serverUrl,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    tokenType: row.tokenType,
    scope: row.scope ?? undefined,
  }
}

export function getToken(serverUrl: string): OAuthToken | null {
  const rows = drizzleDb
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.serverUrl, serverUrl))
    .all()
  if (rows.length === 0) return null
  return rowToOAuthToken(rows[0])
}

export function saveToken(token: OAuthToken): void {
  drizzleDb
    .insert(oauthTokens)
    .values({
      serverUrl: token.serverUrl,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? null,
      expiresAt: token.expiresAt ?? null,
      tokenType: token.tokenType,
      scope: token.scope ?? null,
    })
    .onConflictDoUpdate({
      target: oauthTokens.serverUrl,
      set: {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? null,
        expiresAt: token.expiresAt ?? null,
        tokenType: token.tokenType,
        scope: token.scope ?? null,
      },
    })
    .run()
}

export function deleteToken(serverUrl: string): void {
  drizzleDb.delete(oauthTokens).where(eq(oauthTokens.serverUrl, serverUrl)).run()
}
