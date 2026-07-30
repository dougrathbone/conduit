import { describe, it, expect } from 'vitest'
import { resolveMemoryCapMb, memoryCapEnvEntry } from './runnerMemory'

describe('resolveMemoryCapMb', () => {
  it('prefers the agent override over the server default', () => {
    expect(resolveMemoryCapMb(2048, 4096)).toBe(2048)
  })

  it('falls back to the server default when the agent has none', () => {
    expect(resolveMemoryCapMb(undefined, 4096)).toBe(4096)
    expect(resolveMemoryCapMb(null, 4096)).toBe(4096)
  })

  it('defaults to 0 (uncapped) when neither is set', () => {
    expect(resolveMemoryCapMb(undefined, undefined)).toBe(0)
    expect(resolveMemoryCapMb(null, null)).toBe(0)
  })

  it('treats an explicit agent 0 as uncapped, overriding a server cap', () => {
    expect(resolveMemoryCapMb(0, 4096)).toBe(0)
  })

  it('ignores invalid (negative / non-finite) values and falls through', () => {
    expect(resolveMemoryCapMb(-5, 4096)).toBe(4096)
    expect(resolveMemoryCapMb(NaN, 4096)).toBe(4096)
    expect(resolveMemoryCapMb(-1, -1)).toBe(0)
  })
})

describe('memoryCapEnvEntry', () => {
  it('injects the heap cap as a NODE_OPTIONS flag', () => {
    expect(memoryCapEnvEntry(2048)).toEqual({ NODE_OPTIONS: '--max-old-space-size=2048' })
  })

  it('injects nothing when uncapped', () => {
    expect(memoryCapEnvEntry(0)).toEqual({})
    expect(memoryCapEnvEntry(-1)).toEqual({})
  })

  it('appends to existing NODE_OPTIONS, preserving other flags', () => {
    expect(memoryCapEnvEntry(2048, '--enable-source-maps')).toEqual({
      NODE_OPTIONS: '--enable-source-maps --max-old-space-size=2048',
    })
  })

  it('never overrides a heap cap already set by hand', () => {
    expect(memoryCapEnvEntry(2048, '--max-old-space-size=8192')).toEqual({})
    expect(memoryCapEnvEntry(2048, '--foo --max-old-space-size=1024 --bar')).toEqual({})
  })
})
