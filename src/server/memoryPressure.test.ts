import { describe, it, expect, vi } from 'vitest'

// The reporter is the only impure dependency; stub it so importing the module is
// side-effect-free (mirrors dataDirSweeper.disk.test.ts).
vi.mock('./observability', () => ({
  reporter: { captureMessage: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn() },
}))

import {
  classifyMemoryUsage,
  memoryFraction,
  shouldEscalate,
  measureMemoryPressure,
} from './memoryPressure'

describe('classifyMemoryUsage', () => {
  it('is ok well below the warning threshold', () => {
    expect(classifyMemoryUsage(0)).toBe('ok')
    expect(classifyMemoryUsage(0.5)).toBe('ok')
    expect(classifyMemoryUsage(0.79)).toBe('ok')
  })

  it('warns from 80% and goes critical from 90%', () => {
    expect(classifyMemoryUsage(0.8)).toBe('warning')
    expect(classifyMemoryUsage(0.89)).toBe('warning')
    expect(classifyMemoryUsage(0.9)).toBe('critical')
    expect(classifyMemoryUsage(0.99)).toBe('critical')
  })
})

describe('memoryFraction', () => {
  it('computes used/limit, clamped to [0,1]', () => {
    expect(memoryFraction(0, 100)).toBe(0)
    expect(memoryFraction(80, 100)).toBeCloseTo(0.8)
    expect(memoryFraction(120, 100)).toBe(1) // clamp overshoot
  })
  it('returns 0 for a missing/zero/unlimited limit rather than NaN/Infinity', () => {
    expect(memoryFraction(50, 0)).toBe(0)
    expect(memoryFraction(50, -1)).toBe(0)
  })
})

describe('shouldEscalate', () => {
  it('alerts only when pressure rises to a higher level', () => {
    expect(shouldEscalate('ok', 'warning')).toBe(true)
    expect(shouldEscalate('warning', 'critical')).toBe(true)
    expect(shouldEscalate('ok', 'critical')).toBe(true)
  })
  it('does not re-alert at the same or lower level (prevents per-tick flooding)', () => {
    expect(shouldEscalate('warning', 'warning')).toBe(false)
    expect(shouldEscalate('critical', 'critical')).toBe(false)
    expect(shouldEscalate('critical', 'warning')).toBe(false)
    expect(shouldEscalate('warning', 'ok')).toBe(false)
  })
})

describe('measureMemoryPressure', () => {
  it('returns sane real memory stats (cgroup or os fallback)', async () => {
    const m = await measureMemoryPressure()
    expect(m.limitBytes).toBeGreaterThan(0)
    expect(m.usedBytes).toBeGreaterThanOrEqual(0)
    expect(m.usedFraction).toBeGreaterThanOrEqual(0)
    expect(m.usedFraction).toBeLessThanOrEqual(1)
    expect(['cgroup-v2', 'cgroup-v1', 'os']).toContain(m.source)
  })
})
