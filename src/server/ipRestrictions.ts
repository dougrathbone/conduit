import * as fs from 'fs'
import * as path from 'path'

export interface IpRestrictionsConfig {
  enabled: boolean
  allowedCidrs: string[]
}

// Load config from file + env
export function loadIpRestrictionsConfig(dataDir: string): IpRestrictionsConfig {
  // 1. Check env var CONDUIT_ALLOWED_IPS first
  const envIps = process.env.CONDUIT_ALLOWED_IPS
  if (envIps?.trim()) {
    return {
      enabled: true,
      allowedCidrs: envIps.split(',').map(s => s.trim()).filter(Boolean),
    }
  }

  // 2. Try reading config.json from dataDir
  const configPath = path.join(dataDir, 'config.json')
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (config.ipRestrictions) {
        return {
          enabled: config.ipRestrictions.enabled ?? false,
          allowedCidrs: config.ipRestrictions.allowedCidrs ?? [],
        }
      }
    }
  } catch { /* ignore parse errors */ }

  return { enabled: false, allowedCidrs: [] }
}

// Parse CIDR: "192.168.1.0/24" → { base: number, mask: number }
function parseCidr(cidr: string): { base: number; mask: number } | null {
  const [ipPart, prefixPart] = cidr.includes('/') ? cidr.split('/') : [cidr, '32']
  const prefix = parseInt(prefixPart, 10)
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return null

  const parts = ipPart.split('.')
  if (parts.length !== 4) return null

  let base = 0
  for (const part of parts) {
    const n = parseInt(part, 10)
    if (isNaN(n) || n < 0 || n > 255) return null
    base = (base << 8) | n
  }

  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  base = (base & mask) >>> 0
  return { base, mask }
}

// Parse an IPv4 string to a 32-bit number
function ipToNumber(ip: string): number | null {
  // Handle IPv4-mapped IPv6: "::ffff:192.168.1.1"
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  const v4 = mapped ? mapped[1] : ip

  const parts = v4.split('.')
  if (parts.length !== 4) return null
  let num = 0
  for (const part of parts) {
    const n = parseInt(part, 10)
    if (isNaN(n) || n < 0 || n > 255) return null
    num = (num << 8) | n
  }
  return num >>> 0
}

export function isIpAllowed(ip: string, config: IpRestrictionsConfig): boolean {
  if (!config.enabled || config.allowedCidrs.length === 0) return true

  // Always allow localhost
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true

  const ipNum = ipToNumber(ip)
  if (ipNum === null) {
    // IPv6 that isn't mapped — check for exact string match only
    return config.allowedCidrs.some(cidr => cidr === ip || cidr === `${ip}/128`)
  }

  for (const cidr of config.allowedCidrs) {
    const parsed = parseCidr(cidr)
    if (!parsed) continue
    if ((ipNum & parsed.mask) === parsed.base) return true
  }

  return false
}

// Extract the real client IP from a request, checking X-Forwarded-For and X-Real-IP
export function extractClientIp(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>
): string {
  // X-Forwarded-For: client, proxy1, proxy2
  const forwarded = headers['x-forwarded-for']
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0]
    const cleaned = first.trim()
    if (cleaned) return cleaned
  }

  // X-Real-IP (set by nginx)
  const realIp = headers['x-real-ip']
  if (realIp) {
    return (Array.isArray(realIp) ? realIp[0] : realIp).trim()
  }

  return remoteAddress?.replace(/^::ffff:/, '') ?? '127.0.0.1'
}
