import { describe, it, expect } from 'vitest'
import { isUrlMcpServer, hasManualAuthHeader } from './mcp'

describe('isUrlMcpServer', () => {
  it('treats type "url" with a url as URL-based', () => {
    expect(isUrlMcpServer({ type: 'url', url: 'https://x/mcp' })).toBe(true)
  })

  it('treats type "http" with a url as URL-based (regression: OAuth previously excluded these)', () => {
    expect(isUrlMcpServer({ type: 'http', url: 'https://mcp.sentry.dev/mcp' })).toBe(true)
  })

  it('treats streamable-http and sse transports as URL-based', () => {
    expect(isUrlMcpServer({ type: 'streamable-http', url: 'https://x/mcp' })).toBe(true)
    expect(isUrlMcpServer({ type: 'sse', url: 'https://x/sse' })).toBe(true)
  })

  it('treats a url with no explicit type as URL-based', () => {
    expect(isUrlMcpServer({ url: 'https://x/mcp' })).toBe(true)
  })

  it('is false for stdio servers', () => {
    expect(isUrlMcpServer({ type: 'stdio', command: 'npx', args: ['-y', 'server'] })).toBe(false)
  })

  it('is false when there is no url', () => {
    expect(isUrlMcpServer({ type: 'http' })).toBe(false)
    expect(isUrlMcpServer({ command: 'npx' })).toBe(false)
    expect(isUrlMcpServer(undefined)).toBe(false)
  })
})

describe('hasManualAuthHeader', () => {
  it('detects a Bearer Authorization header (the Datadog PAT case)', () => {
    expect(
      hasManualAuthHeader({ type: 'http', url: 'https://mcp.us3.datadoghq.com/v1/mcp', headers: { Authorization: 'Bearer ddpat_x' } })
    ).toBe(true)
  })

  it('is case-insensitive on the header name', () => {
    expect(hasManualAuthHeader({ url: 'https://x/mcp', headers: { authorization: 'Bearer x' } })).toBe(true)
    expect(hasManualAuthHeader({ url: 'https://x/mcp', headers: { AUTHORIZATION: 'token x' } })).toBe(true)
  })

  it('ignores non-auth headers', () => {
    expect(hasManualAuthHeader({ url: 'https://x/mcp', headers: { 'DD-API-KEY': 'abc', 'Content-Type': 'application/json' } })).toBe(false)
  })

  it('ignores a blank Authorization value', () => {
    expect(hasManualAuthHeader({ url: 'https://x/mcp', headers: { Authorization: '   ' } })).toBe(false)
    expect(hasManualAuthHeader({ url: 'https://x/mcp', headers: { Authorization: '' } })).toBe(false)
  })

  it('is false when there are no headers', () => {
    expect(hasManualAuthHeader({ url: 'https://x/mcp' })).toBe(false)
    expect(hasManualAuthHeader({ type: 'stdio', command: 'npx' })).toBe(false)
    expect(hasManualAuthHeader(undefined)).toBe(false)
  })
})
