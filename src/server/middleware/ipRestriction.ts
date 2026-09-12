import type { Request, Response, NextFunction } from 'express'
import { IpRestrictionsConfig, isIpAllowed, extractClientIp } from '../ipRestrictions'
import { log } from '../logging'

export function createIpRestrictionMiddleware(config: IpRestrictionsConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.enabled) return next()

    const clientIp = extractClientIp(req.socket.remoteAddress, req.headers as any)

    if (isIpAllowed(clientIp, config)) return next()

    log.warn('Blocked HTTP request', { clientIp })
    res.status(403).json({ error: 'Forbidden: IP not in allowlist' })
  }
}
