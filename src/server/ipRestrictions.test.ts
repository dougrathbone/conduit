import { describe, it, expect } from 'vitest'
import { isIpAllowed, type IpRestrictionsConfig } from './ipRestrictions'

function cfg(...allowedCidrs: string[]): IpRestrictionsConfig {
  return { enabled: true, allowedCidrs }
}

describe('isIpAllowed', () => {
  it('allows when restrictions are disabled', () => {
    expect(isIpAllowed('8.8.8.8', { enabled: false, allowedCidrs: [] })).toBe(true)
  })

  it('allows localhost always', () => {
    expect(isIpAllowed('127.0.0.1', cfg('10.0.0.0/8'))).toBe(true)
  })

  it('matches /32 for IPs below 128.x (no signed-bit edge)', () => {
    expect(isIpAllowed('104.28.228.198', cfg('104.28.228.198/32'))).toBe(true)
    expect(isIpAllowed('104.28.228.199', cfg('104.28.228.198/32'))).toBe(false)
  })

  // Regression: JS bitwise ops are signed int32; without >>> 0, any CIDR whose
  // network base has the high bit set (10.x is fine; 172.x / 192.x / 128+ fail).
  it('matches RFC1918 172.16/12-style VPC ranges (high bit set)', () => {
    expect(isIpAllowed('172.31.7.6', cfg('172.31.0.0/16'))).toBe(true)
    expect(isIpAllowed('172.32.0.1', cfg('172.31.0.0/16'))).toBe(false)
    expect(isIpAllowed('192.168.1.10', cfg('192.168.0.0/16'))).toBe(true)
  })

  it('matches /32 for IPs with high bit set', () => {
    expect(isIpAllowed('172.31.7.6', cfg('172.31.7.6/32'))).toBe(true)
    expect(isIpAllowed('172.31.7.7', cfg('172.31.7.6/32'))).toBe(false)
  })
})
