import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory session store standing in for the DB query layer.
const store = new Map<string, any>()
// Configurable refresh behaviour per test.
let refreshImpl: (rt: string) => Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }>
const refreshSpy = vi.fn((rt: string) => refreshImpl(rt))

vi.mock('../../main/db/queries/sessions', () => ({
  getSession: (id: string) => Promise.resolve(store.get(id) ?? null),
  updateSessionTokens: (id: string, data: any) => {
    const cur = store.get(id)
    if (cur) store.set(id, { ...cur, ...data })
    return Promise.resolve()
  },
  deleteSession: (id: string) => {
    store.delete(id)
    return Promise.resolve()
  },
}))
vi.mock('./okta', () => ({ refreshTokens: (rt: string) => refreshSpy(rt) }))
vi.mock('./config', () => ({
  isAuthEnabled: () => true,
  getOktaConfig: () => ({ sessionTtlMs: 86_400_000 }),
}))

import { resolveSession } from './session'

const seed = (over: Record<string, unknown> = {}) => {
  const s = {
    id: 's1',
    userId: 'u1',
    accessToken: 'old-access',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 10 * 60_000,
    createdAt: Date.now(),
    ...over,
  }
  store.set(s.id as string, s)
  return s
}

describe('resolveSession', () => {
  beforeEach(() => {
    store.clear()
    refreshSpy.mockClear()
    refreshImpl = async () => ({ accessToken: 'new-access', refreshToken: 'rt-2', expiresIn: 3600 })
  })

  it('returns null for a missing session', async () => {
    expect(await resolveSession('nope')).toBeNull()
  })

  it('returns a comfortably-valid session without refreshing', async () => {
    seed({ expiresAt: Date.now() + 10 * 60_000 })
    const s = await resolveSession('s1')
    expect(s?.accessToken).toBe('old-access')
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('refreshes and extends an expired session that has a refresh token', async () => {
    seed({ expiresAt: Date.now() - 1_000 })
    const s = await resolveSession('s1')
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(s).not.toBeNull()
    expect(s?.accessToken).toBe('new-access')
    expect(s?.refreshToken).toBe('rt-2')
    expect(s!.expiresAt).toBeGreaterThan(Date.now())
    // persisted
    expect(store.get('s1').accessToken).toBe('new-access')
  })

  it('refreshes a session inside the pre-expiry skew window', async () => {
    seed({ expiresAt: Date.now() + 30_000 }) // < 60s skew
    const s = await resolveSession('s1')
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(s?.accessToken).toBe('new-access')
  })

  it('deletes and returns null when the refresh token is definitively rejected (invalid_grant)', async () => {
    seed({ expiresAt: Date.now() - 1_000 })
    refreshImpl = async () => { throw Object.assign(new Error('invalid_grant'), { error: 'invalid_grant' }) }
    const s = await resolveSession('s1')
    expect(s).toBeNull()
    expect(store.has('s1')).toBe(false)
  })

  it('does NOT delete an expired session on a transient refresh failure', async () => {
    seed({ expiresAt: Date.now() - 1_000 })
    refreshImpl = async () => { throw new Error('ETIMEDOUT') } // network blip, not invalid_grant
    const s = await resolveSession('s1')
    // cannot serve an expired token, but the row must survive for a later retry
    expect(s).toBeNull()
    expect(store.has('s1')).toBe(true)
  })

  it('deletes and returns null when an expired session has no refresh token', async () => {
    seed({ expiresAt: Date.now() - 1_000, refreshToken: null })
    const s = await resolveSession('s1')
    expect(refreshSpy).not.toHaveBeenCalled()
    expect(s).toBeNull()
    expect(store.has('s1')).toBe(false)
  })

  it('keeps serving a not-yet-expired session when refresh fails', async () => {
    seed({ expiresAt: Date.now() + 30_000 }) // within skew but still valid
    refreshImpl = async () => { throw new Error('okta down') }
    const s = await resolveSession('s1')
    expect(s).not.toBeNull()
    expect(s?.accessToken).toBe('old-access')
    expect(store.has('s1')).toBe(true)
  })

  it('dedupes concurrent refreshes so a rotating refresh token is used once', async () => {
    seed({ expiresAt: Date.now() - 1_000 })
    const [a, b] = await Promise.all([resolveSession('s1'), resolveSession('s1')])
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(a?.accessToken).toBe('new-access')
    expect(b?.accessToken).toBe('new-access')
  })
})
