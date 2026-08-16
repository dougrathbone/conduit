import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { resolveProcessMode } from './processMode'

describe('resolveProcessMode', () => {
  it('defaults to server when CONDUIT_PROCESS_MODE is unset or blank', () => {
    expect(resolveProcessMode({})).toBe('server')
    expect(resolveProcessMode({ CONDUIT_PROCESS_MODE: '' })).toBe('server')
    expect(resolveProcessMode({ CONDUIT_PROCESS_MODE: '   ' })).toBe('server')
  })

  it('accepts server and worker, case/whitespace-tolerant', () => {
    expect(resolveProcessMode({ CONDUIT_PROCESS_MODE: 'server' })).toBe('server')
    expect(resolveProcessMode({ CONDUIT_PROCESS_MODE: ' worker ' })).toBe('worker')
    expect(resolveProcessMode({ CONDUIT_PROCESS_MODE: 'WORKER' })).toBe('worker')
  })

  it('fails closed on invalid values', () => {
    expect(() => resolveProcessMode({ CONDUIT_PROCESS_MODE: 'orchestrator' })).toThrow(
      /CONDUIT_PROCESS_MODE/
    )
    expect(() => resolveProcessMode({ CONDUIT_PROCESS_MODE: 'yes' })).toThrow(/CONDUIT_PROCESS_MODE/)
  })
})

describe('container entrypoint', () => {
  const repoRoot = path.resolve(__dirname, '../..')

  it('ships a mode-aware entrypoint script', () => {
    const script = path.join(repoRoot, 'scripts/container-entrypoint.sh')
    expect(fs.existsSync(script)).toBe(true)
    const body = fs.readFileSync(script, 'utf8')
    expect(body).toMatch(/CONDUIT_PROCESS_MODE/)
    expect(body).toMatch(/out\/server\/index\.js/)
    expect(body).toMatch(/out\/worker\/index\.js/)
  })

  it('Dockerfile uses the mode-aware entrypoint', () => {
    const df = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8')
    expect(df).toMatch(/container-entrypoint/)
  })
})
