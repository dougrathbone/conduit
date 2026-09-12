import { describe, it, expect } from 'vitest'
import {
  createLogger,
  formatLogLine,
  formatLogRecord,
  isLevelEnabled,
  parseLogLevel,
  serializeException,
} from './logging'

describe('parseLogLevel', () => {
  it('defaults to info', () => {
    expect(parseLogLevel(undefined)).toBe('info')
    expect(parseLogLevel('')).toBe('info')
    expect(parseLogLevel('nope')).toBe('info')
  })

  it('accepts known levels case-insensitively', () => {
    expect(parseLogLevel(' DEBUG ')).toBe('debug')
    expect(parseLogLevel('Warn')).toBe('warn')
  })
})

describe('isLevelEnabled', () => {
  it('filters below the minimum', () => {
    expect(isLevelEnabled('debug', 'info')).toBe(false)
    expect(isLevelEnabled('info', 'info')).toBe(true)
    expect(isLevelEnabled('error', 'warn')).toBe(true)
  })
})

describe('formatLogRecord', () => {
  it('emits OTel-aligned JSON with stable message and attributes', () => {
    const rec = formatLogRecord({
      timestamp: new Date('2026-09-12T00:00:00.000Z'),
      level: 'error',
      message: 'Terminal finalization failed',
      resource: { serviceName: 'conduit', serviceVersion: 'abc', deploymentEnvironment: 'production' },
      fields: { component: 'worker-control', runId: 'run-1', workerId: 'w-1' },
    })
    expect(rec).toMatchObject({
      timestamp: '2026-09-12T00:00:00.000Z',
      severity: 'ERROR',
      level: 'error',
      body: 'Terminal finalization failed',
      message: 'Terminal finalization failed',
      'service.name': 'conduit',
      'service.version': 'abc',
      'deployment.environment.name': 'production',
      component: 'worker-control',
      runId: 'run-1',
      workerId: 'w-1',
    })
  })

  it('promotes err onto exception.* semantic conventions', () => {
    const err = new Error('boom')
    err.name = 'TypeError'
    const rec = formatLogRecord({
      timestamp: new Date('2026-09-12T00:00:00.000Z'),
      level: 'error',
      message: 'Spawn failed',
      resource: { serviceName: 'conduit' },
      fields: { err, runId: 'r1' },
    })
    expect(rec['exception.type']).toBe('TypeError')
    expect(rec['exception.message']).toBe('boom')
    expect(rec['exception.stacktrace']).toContain('boom')
    expect(rec).not.toHaveProperty('err')
  })
})

describe('formatLogLine', () => {
  it('is a single JSON object', () => {
    const line = formatLogLine({
      timestamp: new Date('2026-09-12T00:00:00.000Z'),
      level: 'info',
      message: 'hello',
      resource: { serviceName: 'conduit-worker' },
    })
    expect(JSON.parse(line).body).toBe('hello')
  })
})

describe('serializeException', () => {
  it('stringifies non-Error values', () => {
    expect(serializeException('nope')).toEqual({
      'exception.type': 'Error',
      'exception.message': 'nope',
    })
  })
})

describe('createLogger', () => {
  it('writes JSON lines and honors minLevel', () => {
    const lines: string[] = []
    const otel: Array<{ level: string; message: string }> = []
    const log = createLogger({
      resource: { serviceName: 'conduit' },
      minLevel: 'info',
      sinks: {
        writeLine: (line) => lines.push(line),
        emitOtel: (level, message) => otel.push({ level, message }),
      },
    })
    log.debug('skip me')
    log.info('Worker connected', { workerId: 'w1' })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).workerId).toBe('w1')
    expect(otel).toEqual([{ level: 'info', message: 'Worker connected' }])
  })

  it('child() binds fields and still reaches the parent sinks', () => {
    const lines: string[] = []
    const log = createLogger({
      resource: { serviceName: 'conduit' },
      minLevel: 'info',
      sinks: { writeLine: (line) => lines.push(line) },
    })
    log.child({ component: 'runner' }).error('Publish failed', { runId: 'r1' })
    const rec = JSON.parse(lines[0])
    expect(rec.component).toBe('runner')
    expect(rec.runId).toBe('r1')
    expect(rec.body).toBe('Publish failed')
  })
})
