import { describe, it, expect, beforeEach, vi } from 'vitest'

const rows: Array<{ userId: string; runner: string; valueEnc: string; updatedAt: number }> = []

function matchRow(row: { userId: string; runner: string }, cond: { op: string; col?: string; v?: unknown; conds?: typeof cond[] }): boolean {
  if (!cond) return true
  if (cond.op === 'and') return (cond.conds ?? []).every((c) => matchRow(row, c))
  if (cond.op === 'eq') return row[cond.col as 'userId' | 'runner'] === cond.v
  return true
}

vi.mock('../index', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (cond: { op: string; col?: string; v?: unknown; conds?: never[] }) =>
          Promise.resolve(rows.filter((r) => matchRow(r, cond))),
      }),
    }),
  }),
}))

vi.mock('../schema', () => ({
  agentCredentials: { userId: 'userId', runner: 'runner', valueEnc: 'valueEnc', updatedAt: 'updatedAt' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, v: unknown) => ({ op: 'eq', col, v }),
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
}))

vi.mock('../../../server/crypto', () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ''),
}))

import { resolveRunnerCredential } from './agentCredentials'

describe('resolveRunnerCredential', () => {
  beforeEach(() => { rows.length = 0 })

  it('uses the acting user\'s key when they have saved one', async () => {
    rows.push(
      { userId: 'owner', runner: 'cursor', valueEnc: 'enc:owner-key', updatedAt: 2 },
      { userId: 'other', runner: 'cursor', valueEnc: 'enc:newer-key', updatedAt: 3 },
    )
    expect(await resolveRunnerCredential('owner', 'cursor')).toBe('owner-key')
  })

  it('uses the most recently saved key for that CLI when the acting user has none', async () => {
    rows.push(
      { userId: 'alice', runner: 'cursor', valueEnc: 'enc:older', updatedAt: 1 },
      { userId: 'bob', runner: 'cursor', valueEnc: 'enc:newest', updatedAt: 5 },
      { userId: 'alice', runner: 'claude', valueEnc: 'enc:claude-key', updatedAt: 9 },
    )
    expect(await resolveRunnerCredential('owner-without-a-key', 'cursor')).toBe('newest')
  })

  it('does not borrow a key saved for a different CLI', async () => {
    rows.push({ userId: 'alice', runner: 'claude', valueEnc: 'enc:claude-key', updatedAt: 1 })
    expect(await resolveRunnerCredential('owner-without-a-key', 'cursor')).toBeNull()
  })
})
