// src/server/mcpHealth.test.ts
import { describe, it, expect } from 'vitest'
import { classifyUrlHealth } from './mcpHealth'

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
