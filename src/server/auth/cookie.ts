import type { Request, Response } from 'express'
import { getOktaConfig } from './config'

export const SESSION_COOKIE_NAME = 'conduit_session'

function cookieOptions(req: Request) {
  // `secure` must be off for localhost (no HTTPS) or the browser drops the cookie.
  const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1'
  return {
    httpOnly: true as const,
    sameSite: 'lax' as const,
    maxAge: getOktaConfig().sessionTtlMs,
    secure: !isLocalhost,
  }
}

/**
 * (Re)issue the session cookie with a fresh maxAge. Called on login AND on every
 * authenticated request, so the cookie's lifetime is a sliding window from the
 * user's last activity rather than a fixed wall-clock cap from login — otherwise
 * an actively-used session would still be forced back to login when the original
 * cookie lapsed, defeating the server-side token refresh.
 */
export function setSessionCookie(req: Request, res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE_NAME, sessionId, cookieOptions(req))
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME)
}
