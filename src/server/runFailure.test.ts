import { describe, it, expect } from 'vitest'
import { buildRunFailureReport, failedStartLastLine, cliKillDiagnostic } from './runFailure'

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

  it('renders a null exit code (killed by signal) as "signal" and escalates to error', () => {
    const r = buildRunFailureReport({ runId: 'r3', runner: 'claude', exitCode: null, lastLine: '' })
    expect(r.ctx.tags?.exitCode).toBe('signal')
    expect(r.message).toContain('signal')
    // A signal kill (OOM / disk-pressure eviction) is the "log just stops" failure
    // — surface it at error level, not hidden at warning, with a flagging tag.
    expect(r.level).toBe('error')
    expect(r.ctx.tags?.killedBySignal).toBe('true')
  })

  it('tags a normal exit as not killed by signal', () => {
    const r = buildRunFailureReport({ runId: 'r4', runner: 'claude', exitCode: 1, lastLine: 'boom' })
    expect(r.ctx.tags?.killedBySignal).toBe('false')
  })
})

describe('failedStartLastLine', () => {
  it('prefixes the thrown message so run history is not blank', () => {
    expect(failedStartLastLine(new Error('Not enough disk space to start this run. Free space on the Conduit server or increase its data volume, then retry.'))).toMatch(
      /^Failed to start run: Not enough disk space/
    )
  })
})

describe('cliKillDiagnostic', () => {
  it('ignores a clean exit and a cooperative SIGTERM', () => {
    expect(cliKillDiagnostic(0, null)).toBeUndefined()
    expect(cliKillDiagnostic(null, 'SIGTERM')).toBeUndefined()
    expect(cliKillDiagnostic(1, null)).toBeUndefined()
  })

  it('describes SIGKILL / exit 137 as an OOM-or-disk eviction', () => {
    expect(cliKillDiagnostic(null, 'SIGKILL')).toMatch(/killed \(SIGKILL\)/)
    expect(cliKillDiagnostic(137, null)).toMatch(/killed \(SIGKILL\)/)
  })
})
