import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory session store backing the mocked drizzle db.
const store = new Map<string, any>()

vi.mock('../index', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (w: any) =>
          Promise.resolve([...store.values()].filter((r) => r.id === w._value)),
      }),
    }),
    insert: () => ({ values: (v: any) => { store.set(v.id, v); return Promise.resolve() } }),
    delete: () => ({
      where: (w: any) => {
        store.delete(w._value)
        return Promise.resolve()
      },
    }),
  }),
}))
vi.mock('../schema', () => ({ sessions: { id: {}, expiresAt: {} } }))
vi.mock('drizzle-orm', () => ({
  eq: (_col: any, v: any) => ({ _value: v }),
  lt: (_col: any, v: any) => ({ _lt: v }),
}))

import { getSession } from './sessions'

// getSession is a pure raw read: no expiry/refresh policy lives here. Expiry and
// refresh are owned by resolveSession (src/server/auth/session.ts) so that the
// raw row — including its refresh token — is available to renew an expired
// session instead of the row being purged before it can be refreshed.
describe('getSession (raw read)', () => {
  beforeEach(() => store.clear())

  it('returns the row for a live session', async () => {
    store.set('live', { id: 'live', userId: 'u1', expiresAt: Date.now() + 60_000 })
    const session = await getSession('live')
    expect(session?.id).toBe('live')
  })

  it('returns the row even when it has expired (no purge, no expiry policy)', async () => {
    store.set('stale', { id: 'stale', userId: 'u1', expiresAt: Date.now() - 1_000 })
    const session = await getSession('stale')
    expect(session?.id).toBe('stale')
    // raw read must not delete the row — resolveSession decides its fate
    expect(store.has('stale')).toBe(true)
  })

  it('returns null when the session does not exist', async () => {
    expect(await getSession('missing')).toBeNull()
  })
})
