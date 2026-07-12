// src/server/mcpHealth.test.ts
import { describe, it, expect } from 'vitest'
import { classifyUrlHealth, buildHealthProbeHeaders } from './mcpHealth'

describe('classifyUrlHealth', () => {
  it('401 -> unauthorized', () => {
    const result = classifyUrlHealth(401, 'Unauthorized')
    expect(result.status).toBe('unauthorized')
    expect(result.message).toContain('401')
  })

  it('403 -> unauthorized', () => {
    const result = classifyUrlHealth(403, 'Forbidden')
    expect(result.status).toBe('unauthorized')
    expect(result.message).toContain('403')
  })

  it('200 -> healthy', () => {
    const result = classifyUrlHealth(200, 'OK')
    expect(result.status).toBe('healthy')
    expect(result.message).toContain('200')
  })

  it('500 -> healthy (reachable but erroring)', () => {
    const result = classifyUrlHealth(500, 'Internal Server Error')
    expect(result.status).toBe('healthy')
    expect(result.message).toContain('500')
  })

  it('405 -> healthy without a "Method Not Allowed" message (streamable-HTTP MCP declines the probe method)', () => {
    const result = classifyUrlHealth(405, 'Method Not Allowed')
    expect(result.status).toBe('healthy')
    expect(result.message).not.toContain('Method Not Allowed')
    expect(result.message).toBe('Reachable')
  })

  it('406 -> healthy without a "Not Acceptable" message', () => {
    const result = classifyUrlHealth(406, 'Not Acceptable')
    expect(result.status).toBe('healthy')
    expect(result.message).not.toContain('Not Acceptable')
    expect(result.message).toBe('Reachable')
  })
})

describe('buildHealthProbeHeaders', () => {
  it('sends a manually supplied Authorization header (so the probe reflects real auth, not a 401)', () => {
    const headers = buildHealthProbeHeaders({ Authorization: 'Bearer ddpat_x' })
    expect(headers.Authorization).toBe('Bearer ddpat_x')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Accept).toBe('application/json, text/event-stream')
  })

  it('carries other custom headers (e.g. Datadog DD-API-KEY style)', () => {
    const headers = buildHealthProbeHeaders({ 'DD-API-KEY': 'abc', 'DD-APPLICATION-KEY': 'def' })
    expect(headers['DD-API-KEY']).toBe('abc')
    expect(headers['DD-APPLICATION-KEY']).toBe('def')
  })

  it('forces the streamable-HTTP Accept even if the config tries to override it', () => {
    const headers = buildHealthProbeHeaders({ Accept: 'text/plain' })
    expect(headers.Accept).toBe('application/json, text/event-stream')
  })

  it('lets a resolved OAuth token override the manual Authorization header', () => {
    const headers = buildHealthProbeHeaders({ Authorization: 'Bearer manual' }, 'Bearer token-from-oauth')
    expect(headers.Authorization).toBe('Bearer token-from-oauth')
  })

  it('works with no config headers', () => {
    const headers = buildHealthProbeHeaders(undefined)
    expect(headers.Authorization).toBeUndefined()
    expect(headers['Content-Type']).toBe('application/json')
  })
})
