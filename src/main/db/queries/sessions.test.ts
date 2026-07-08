import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory session store backing the mocked drizzle db.
const store = new Map<string, any>()
// When true, the mocked delete rejects — simulates a DB write failure.
let deleteShouldThrow = false

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
        if (deleteShouldThrow) return Promise.reject(new Error('db write failed'))
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

describe('getSession', () => {
  beforeEach(() => {
    store.clear()
    deleteShouldThrow = false
  })

  it('returns the session when it has not expired', async () => {
    store.set('live', {
      id: 'live',
      userId: 'u1',
      accessToken: 'tok',
      refreshToken: null,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    })

    const session = await getSession('live')

    expect(session).not.toBeNull()
    expect(session?.id).toBe('live')
  })

  it('treats an expired session as absent and purges it', async () => {
    store.set('stale', {
      id: 'stale',
      userId: 'u1',
      accessToken: 'tok',
      refreshToken: null,
      expiresAt: Date.now() - 1_000,
      createdAt: Date.now() - 120_000,
    })

    const session = await getSession('stale')

    expect(session).toBeNull()
    // the expired row is deleted so it never lingers past its lifetime
    expect(store.has('stale')).toBe(false)
  })

  it('still reports an expired session as absent when the purge write fails', async () => {
    deleteShouldThrow = true
    store.set('stale', {
      id: 'stale',
      userId: 'u1',
      accessToken: 'tok',
      refreshToken: null,
      expiresAt: Date.now() - 1_000,
      createdAt: Date.now() - 120_000,
    })

    // Best-effort purge: a failed delete must not throw or hang the caller;
    // getSession must still resolve to null so the session reads as expired.
    await expect(getSession('stale')).resolves.toBeNull()
  })
})
