import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory store backing the mocked drizzle db. Rows are plain objects keyed by id.
const store = new Map<string, any>()
// Flips true if production code ever issues a hard DELETE — soft-delete must never do this.
let deleteWasCalled = false

// Mocked drizzle operators return descriptor objects; `matchRow` interprets them.
function matchRow(row: any, cond: any): boolean {
  if (!cond) return true
  switch (cond.op) {
    case 'eq':
      return row[cond.col] === cond.v
    case 'isNull':
      return row[cond.col] === null || row[cond.col] === undefined
    case 'and':
      return cond.conds.every((c: any) => matchRow(row, c))
    default:
      return true
  }
}

// Thenable query builder: `.from()` is awaitable (all rows) and chainable via `.where()`.
class Q {
  constructor(public rows: any[]) {}
  where(cond: any): Q {
    return new Q(this.rows.filter((r) => matchRow(r, cond)))
  }
  orderBy(): Q {
    return this
  }
  then(resolve: (rows: any[]) => unknown, reject?: (e: unknown) => unknown) {
    return Promise.resolve(this.rows).then(resolve, reject)
  }
}

vi.mock('../index', () => ({
  getDb: () => ({
    select: () => ({ from: () => new Q([...store.values()]) }),
    insert: () => ({
      values: (v: any) => {
        store.set(v.id, { ...v })
        return Promise.resolve()
      },
    }),
    update: () => ({
      set: (vals: any) => ({
        where: (cond: any) => {
          for (const r of store.values()) if (matchRow(r, cond)) Object.assign(r, vals)
          return Promise.resolve()
        },
      }),
    }),
    delete: () => ({
      where: () => {
        deleteWasCalled = true
        return Promise.resolve()
      },
    }),
  }),
}))

// Column tokens map to their own name so mocked operators can carry the column key.
vi.mock('../schema', () => ({
  agents: {
    id: 'id',
    name: 'name',
    description: 'description',
    runner: 'runner',
    prompt: 'prompt',
    envVars: 'envVars',
    mcpConfig: 'mcpConfig',
    gistId: 'gistId',
    workingDir: 'workingDir',
    publishTargetIds: 'publishTargetIds',
    repositoryId: 'repositoryId',
    effort: 'effort',
    bgTaskTimeoutSeconds: 'bgTaskTimeoutSeconds',
    enableRepoMcps: 'enableRepoMcps',
    ownerId: 'ownerId',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    deletedAt: 'deletedAt',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, v: unknown) => ({ op: 'eq', col, v }),
  isNull: (col: string) => ({ op: 'isNull', col }),
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
  desc: (col: string) => ({ op: 'desc', col }),
}))

// Every seeded agent is visible, so the deletedAt filter is what these tests exercise.
vi.mock('./access', () => ({
  getVisibleEntityIds: async () => [...store.values()].map((r) => r.id),
}))
vi.mock('./globalMcps', () => ({
  findAgentMcpKeyConflictWithGlobals: async () => null,
}))
vi.mock('./shares', () => ({
  deleteSharesForEntity: vi.fn(async () => {}),
}))

import { deleteAgent, getAgent, listAgents } from './agents'

function seed(partial: { id: string; deletedAt?: number | null; name?: string }): void {
  store.set(partial.id, {
    id: partial.id,
    name: partial.name ?? 'Agent',
    description: null,
    runner: 'claude',
    prompt: 'do the thing',
    envVars: '{}',
    mcpConfig: '{"mcpServers":{}}',
    gistId: null,
    workingDir: null,
    publishTargetIds: null,
    repositoryId: null,
    effort: null,
    bgTaskTimeoutSeconds: null,
    enableRepoMcps: false,
    ownerId: 'u1',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: partial.deletedAt ?? null,
  })
}

beforeEach(() => {
  store.clear()
  deleteWasCalled = false
})

describe('deleteAgent (soft-delete)', () => {
  it('marks the row deleted via UPDATE and never issues a hard DELETE', async () => {
    seed({ id: 'a1' })

    await deleteAgent('a1')

    expect(deleteWasCalled).toBe(false)
    expect(typeof store.get('a1').deletedAt).toBe('number')
    // Row is preserved so its run history (runs.agent_id FK) stays valid.
    expect(store.has('a1')).toBe(true)
  })
})

describe('getAgent', () => {
  it('returns null for a soft-deleted agent', async () => {
    seed({ id: 'gone', deletedAt: 123 })
    expect(await getAgent('gone')).toBeNull()
  })

  it('returns an active agent', async () => {
    seed({ id: 'live' })
    expect((await getAgent('live'))?.id).toBe('live')
  })
})

describe('listAgents', () => {
  it('excludes soft-deleted agents', async () => {
    seed({ id: 'live' })
    seed({ id: 'gone', deletedAt: 123 })

    const list = await listAgents('u1', [])

    expect(list.map((a) => a.id)).toEqual(['live'])
  })
})
