import type { Request, Response, NextFunction } from 'express'
import type { RequestContext } from '../../shared/types'
import { isAuthEnabled } from './config'
import { getDevContext } from './devBypass'
import { resolveSession } from './session'
import { setSessionCookie, SESSION_COOKIE_NAME } from './cookie'
import { getUserGroupIds } from '../../main/db/queries/groups'

declare global {
  namespace Express {
    interface Request {
      context?: RequestContext
    }
  }
}

export async function sessionMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isAuthEnabled()) {
    req.context = getDevContext()
    next()
    return
  }

  const sessionId: string | undefined = req.cookies?.[SESSION_COOKIE_NAME]
  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }

  try {
    // resolveSession enforces expiry and refreshes via the Okta refresh token
    // when possible; a null result means the session is truly dead.
    const session = await resolveSession(sessionId)
    if (!session) {
      res.status(401).json({ error: 'Session expired' })
      return
    }

    const userGroupIds = await getUserGroupIds(session.userId)
    req.context = {
      userId: session.userId,
      userGroupIds,
    }
    // Slide the cookie forward on activity (rolling session window).
    setSessionCookie(req, res, sessionId)

    next()
  } catch (err) {
    next(err)
  }
}
