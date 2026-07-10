import { describe, it, expect } from 'vitest'
import { buildRunFailureReport } from './runFailure'

describe('buildRunFailureReport', () => {
  it('flags a disk-full failure at error level with a diskFull tag', () => {
    const r = buildRunFailureReport({
      runId: 'r1',
      runner: 'claude',
      exitCode: 128,
      lastLine: 'error: unable to create file x: No space left on device',
    })
    expect(r.level).toBe('error')
    expect(r.ctx.tags?.diskFull).toBe('true')
    expect(r.ctx.tags?.exitCode).toBe('128')
    expect(r.message).toMatch(/failed/i)
  })

  it('reports a non-disk failure at warning level', () => {
    const r = buildRunFailureReport({
      runId: 'r2',
      runner: 'amp',
      exitCode: 1,
      lastLine: 'TypeError: something broke',
    })
    expect(r.level).toBe('warning')
    expect(r.ctx.tags?.diskFull).toBe('false')
    expect(r.ctx.tags?.runId).toBe('r2')
  })

  it('renders a null exit code (killed by signal) as "signal"', () => {
    const r = buildRunFailureReport({ runId: 'r3', runner: 'claude', exitCode: null, lastLine: '' })
    expect(r.ctx.tags?.exitCode).toBe('signal')
    expect(r.message).toContain('signal')
  })
})
