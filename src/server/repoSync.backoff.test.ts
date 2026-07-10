import { describe, it, expect } from 'vitest'
import { computeSyncBackoffMs, isInSyncBackoff, nextSyncBackoff } from './repoSync'

const MIN = 60 * 1000

describe('computeSyncBackoffMs', () => {
  it('starts at 10 min and doubles per consecutive failure', () => {
    expect(computeSyncBackoffMs(1)).toBe(10 * MIN)
    expect(computeSyncBackoffMs(2)).toBe(20 * MIN)
    expect(computeSyncBackoffMs(3)).toBe(40 * MIN)
  })

  it('caps at 4 hours', () => {
    expect(computeSyncBackoffMs(6)).toBe(4 * 60 * MIN)
    expect(computeSyncBackoffMs(100)).toBe(4 * 60 * MIN)
  })

  it('treats 0/negative failures as a single failure (never below the base)', () => {
    expect(computeSyncBackoffMs(0)).toBe(10 * MIN)
  })
})

describe('nextSyncBackoff', () => {
  it('records the first failure with a base-delay next-attempt time', () => {
    const s = nextSyncBackoff(undefined, 1_000)
    expect(s.count).toBe(1)
    expect(s.nextAttemptAt).toBe(1_000 + 10 * MIN)
  })

  it('escalates the delay on each subsequent failure', () => {
    const first = nextSyncBackoff(undefined, 0)
    const second = nextSyncBackoff(first, 100)
    expect(second.count).toBe(2)
    expect(second.nextAttemptAt).toBe(100 + 20 * MIN)
  })
})

describe('isInSyncBackoff', () => {
  it('is false when there is no recorded failure', () => {
    expect(isInSyncBackoff(undefined, 999)).toBe(false)
  })

  it('is true before the next-attempt time and false at/after it', () => {
    const s = nextSyncBackoff(undefined, 0) // nextAttemptAt = 10 min
    expect(isInSyncBackoff(s, 10 * MIN - 1)).toBe(true)
    expect(isInSyncBackoff(s, 10 * MIN)).toBe(false)
  })
})
