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
    update: () => ({
      set: (vals: any) => ({
        where: (w: any) => {
          const cur = store.get(w._value)
          if (cur) store.set(w._value, { ...cur, ...vals })
          return Promise.resolve()
        },
      }),
    }),
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
// Fake symmetric crypto: `enc(x)` is the ciphertext; decrypt throws on anything
// that isn't in that shape (mirrors decryptSecret rejecting a malformed blob).
vi.mock('../../../server/crypto', () => ({
  encryptSecret: (s: string) => `enc(${s})`,
  decryptSecret: (s: string) => {
    const m = /^enc\((.*)\)$/.exec(s)
    if (!m) throw new Error('malformed encrypted secret')
    return m[1]
  },
}))

import { getSession, createSession, updateSessionTokens } from './sessions'

describe('getSession (raw read, token decryption)', () => {
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

  it('decrypts the access and refresh tokens on read', async () => {
    store.set('enc', {
      id: 'enc',
      userId: 'u1',
      accessToken: 'enc(AT)',
      refreshToken: 'enc(RT)',
      expiresAt: Date.now() + 60_000,
    })
    const s = await getSession('enc')
    expect(s?.accessToken).toBe('AT')
    expect(s?.refreshToken).toBe('RT')
  })

  it('falls back to the raw value for a legacy plaintext token (pre-encryption)', async () => {
    store.set('legacy', {
      id: 'legacy',
      userId: 'u1',
      accessToken: 'plain-AT', // not enc(...) => decrypt throws => treated as legacy
      refreshToken: 'plain-RT',
      expiresAt: Date.now() + 60_000,
    })
    const s = await getSession('legacy')
    expect(s?.accessToken).toBe('plain-AT')
    expect(s?.refreshToken).toBe('plain-RT')
  })

  it('falls back to the raw value for a ciphertext-shaped token it cannot decrypt', async () => {
    // Simulates a wrong/rotated key: the value looks like iv:authTag:ciphertext
    // but decryption throws. Degrade safely (return raw) rather than crashing.
    store.set('badkey', {
      id: 'badkey',
      userId: 'u1',
      accessToken: 'aa:bb:cc',
      refreshToken: 'aa:bb:cc',
      expiresAt: Date.now() + 60_000,
    })
    const s = await getSession('badkey')
    expect(s?.accessToken).toBe('aa:bb:cc')
    expect(s?.refreshToken).toBe('aa:bb:cc')
  })
})

describe('session token encryption at rest', () => {
  beforeEach(() => store.clear())

  it('encrypts tokens when creating a session', async () => {
    const s = await createSession({
      userId: 'u1',
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: Date.now() + 60_000,
    })
    const stored = store.get(s.id)
    expect(stored.accessToken).toBe('enc(AT)')
    expect(stored.refreshToken).toBe('enc(RT)')
    // the returned object exposes plaintext, not ciphertext
    expect(s.accessToken).toBe('AT')
    expect(s.refreshToken).toBe('RT')
  })

  it('encrypts tokens when updating session tokens', async () => {
    store.set('x', { id: 'x', userId: 'u1', accessToken: 'enc(old)', refreshToken: 'enc(old)', expiresAt: 1 })
    await updateSessionTokens('x', { accessToken: 'AT2', refreshToken: 'RT2', expiresAt: Date.now() + 60_000 })
    const stored = store.get('x')
    expect(stored.accessToken).toBe('enc(AT2)')
    expect(stored.refreshToken).toBe('enc(RT2)')
  })
})
