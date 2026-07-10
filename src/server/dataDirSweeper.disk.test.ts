import { describe, it, expect, vi } from 'vitest'

// Keep loading dataDirSweeper free of real I/O / the runner graph (same pattern
// as dataDirSweeper.test.ts).
vi.mock('./runner', () => ({
  getActiveWorkspacePaths: () => new Set<string>(),
  getActiveRunIds: () => new Set<string>(),
}))
vi.mock('./gitOps', () => ({ removeWorktree: vi.fn(async () => {}) }))
vi.mock('../main/execution/workspace', () => ({ deleteWorkspace: vi.fn(() => {}) }))
vi.mock('./observability', () => ({ reporter: { captureException: vi.fn() } }))
vi.mock('../main/utils/paths', () => ({ REPOS_DIR: '/nonexistent-repos', DATA_DIR: '/nonexistent-data' }))

import { classifyDiskUsage, measureDiskPressure } from './dataDirSweeper'

describe('classifyDiskUsage', () => {
  it('is ok well below the warning threshold', () => {
    expect(classifyDiskUsage(0)).toBe('ok')
    expect(classifyDiskUsage(0.5)).toBe('ok')
    expect(classifyDiskUsage(0.79)).toBe('ok')
  })

  it('warns from 80% and goes critical from 90%', () => {
    expect(classifyDiskUsage(0.8)).toBe('warning')
    expect(classifyDiskUsage(0.89)).toBe('warning')
    expect(classifyDiskUsage(0.9)).toBe('critical')
    expect(classifyDiskUsage(0.99)).toBe('critical')
  })
})

describe('measureDiskPressure', () => {
  it('returns sane real filesystem stats for an existing directory', async () => {
    const p = await measureDiskPressure(process.cwd())
    expect(p.totalBytes).toBeGreaterThan(0)
    expect(p.freeBytes).toBeGreaterThanOrEqual(0)
    expect(p.usedFraction).toBeGreaterThanOrEqual(0)
    expect(p.usedFraction).toBeLessThanOrEqual(1)
  })
})
