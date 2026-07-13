import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Trigger, AgentConfig } from '../../shared/types'

// node-cron: record every scheduled expression; return a stoppable fake task.
const scheduled: string[] = []
vi.mock('node-cron', () => ({
  default: {
    schedule: (expression: string) => {
      scheduled.push(expression)
      return { stop: () => {} }
    },
  },
}))

// Enabled triggers loaded at startup — one for a live agent, one for a deleted agent.
let enabledTriggers: Trigger[] = []
vi.mock('../../main/db/queries/triggers', () => ({
  listAllEnabledTriggers: async () => enabledTriggers,
  getTrigger: async () => null,
  updateTrigger: async () => {},
}))

// getAgent returns null for soft-deleted agents (mirrors the real query filter).
const liveAgentIds = new Set<string>()
vi.mock('../../main/db/queries/agents', () => ({
  getAgent: async (id: string): Promise<AgentConfig | null> =>
    liveAgentIds.has(id) ? ({ id } as AgentConfig) : null,
}))

vi.mock('../runner', () => ({ startRunServer: async () => ({ id: 'run1' }) }))
vi.mock('../observability', () => ({ reporter: { captureException: () => {} } }))

import { TriggerService } from './triggerService'

function cronTrigger(id: string, agentId: string): Trigger {
  return {
    id,
    agentId,
    name: `trigger-${id}`,
    type: 'cron',
    config: { expression: '* * * * *' } as Trigger['config'],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeEach(() => {
  scheduled.length = 0
  liveAgentIds.clear()
  enabledTriggers = []
})

describe('TriggerService.start', () => {
  it('skips cron triggers whose agent has been soft-deleted', async () => {
    liveAgentIds.add('live-agent')
    enabledTriggers = [
      cronTrigger('t-live', 'live-agent'),
      cronTrigger('t-deleted', 'deleted-agent'),
    ]

    const service = new TriggerService(() => {})
    await service.start()

    // Only the live agent's cron should have been registered.
    expect(scheduled).toEqual(['* * * * *'])
  })

  it('registers cron triggers for live agents', async () => {
    liveAgentIds.add('live-agent')
    enabledTriggers = [cronTrigger('t-live', 'live-agent')]

    const service = new TriggerService(() => {})
    await service.start()

    expect(scheduled).toHaveLength(1)
  })
})
