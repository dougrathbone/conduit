import { describe, it, expect, vi, afterEach } from 'vitest'

const { statfs } = vi.hoisted(() => ({ statfs: vi.fn() }))
vi.mock('fs', () => ({
  promises: { statfs },
}))

import {
  classifyDiskUsage,
  measureDiskPressure,
  assertVolumeHasSpace,
  DISK_CRITICAL_FRACTION,
} from './diskPressure'

afterEach(() => {
  statfs.mockReset()
})

describe('classifyDiskUsage', () => {
  it('is ok well below the warning threshold', () => {
    expect(classifyDiskUsage(0)).toBe('ok')
    expect(classifyDiskUsage(0.5)).toBe('ok')
    expect(classifyDiskUsage(0.79)).toBe('ok')
  })

  it('warns from 80% and goes critical from 90%', () => {
    expect(classifyDiskUsage(0.8)).toBe('warning')
    expect(classifyDiskUsage(0.89)).toBe('warning')
    expect(classifyDiskUsage(DISK_CRITICAL_FRACTION)).toBe('critical')
    expect(classifyDiskUsage(0.99)).toBe('critical')
  })
})

describe('measureDiskPressure', () => {
  it('computes used fraction from statfs blocks', async () => {
    statfs.mockResolvedValue({ bsize: 1024, blocks: 100, bavail: 10 })
    const p = await measureDiskPressure('/data')
    expect(p.totalBytes).toBe(1024 * 100)
    expect(p.freeBytes).toBe(1024 * 10)
    expect(p.usedFraction).toBeCloseTo(0.9)
  })
})

describe('assertVolumeHasSpace', () => {
  it('throws an operator-facing message when the volume is critically full', async () => {
    statfs.mockResolvedValue({ bsize: 1024, blocks: 100, bavail: 5 })
    await expect(assertVolumeHasSpace('/data', 'start this run')).rejects.toThrow(
      /Not enough disk space to start this run/
    )
  })

  it('does not throw when the volume has headroom', async () => {
    statfs.mockResolvedValue({ bsize: 1024, blocks: 100, bavail: 50 })
    await expect(assertVolumeHasSpace('/data', 'start this run')).resolves.toBeUndefined()
  })

  it('does not block a run when statfs fails', async () => {
    statfs.mockRejectedValue(new Error('ENOENT'))
    await expect(assertVolumeHasSpace('/missing', 'start this run')).resolves.toBeUndefined()
  })
})
