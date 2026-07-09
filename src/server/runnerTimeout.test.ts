import { describe, it, expect } from 'vitest'
import {
  RUNNER_TIMEOUT_ENV_VAR,
  resolveBgTaskTimeoutSeconds,
  bgTaskTimeoutEnvEntry,
} from './runnerTimeout'

describe('resolveBgTaskTimeoutSeconds', () => {
  it('prefers the agent override over the user setting', () => {
    expect(resolveBgTaskTimeoutSeconds(5, 600)).toBe(5)
  })

  it('falls back to the user setting when the agent has none', () => {
    expect(resolveBgTaskTimeoutSeconds(undefined, 600)).toBe(600)
    expect(resolveBgTaskTimeoutSeconds(null, 600)).toBe(600)
  })

  it('defaults to 0 (run indefinitely) when neither is set', () => {
    expect(resolveBgTaskTimeoutSeconds(undefined, undefined)).toBe(0)
    expect(resolveBgTaskTimeoutSeconds(null, null)).toBe(0)
  })

  it('treats an explicit agent 0 as indefinite, overriding a user ceiling', () => {
    expect(resolveBgTaskTimeoutSeconds(0, 600)).toBe(0)
  })

  it('treats an explicit user 0 as indefinite when the agent is unset', () => {
    expect(resolveBgTaskTimeoutSeconds(undefined, 0)).toBe(0)
  })

  it('ignores invalid (negative / non-finite) values and falls through', () => {
    expect(resolveBgTaskTimeoutSeconds(-5, 600)).toBe(600)
    expect(resolveBgTaskTimeoutSeconds(NaN, 600)).toBe(600)
    expect(resolveBgTaskTimeoutSeconds(-1, -1)).toBe(0)
  })
})

describe('bgTaskTimeoutEnvEntry', () => {
  const CLAUDE_VAR = 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'

  it('maps only Claude to its known env var', () => {
    expect(RUNNER_TIMEOUT_ENV_VAR.claude).toBe(CLAUDE_VAR)
    expect(RUNNER_TIMEOUT_ENV_VAR.amp).toBeUndefined()
    expect(RUNNER_TIMEOUT_ENV_VAR.cursor).toBeUndefined()
  })

  it('injects the Claude ceiling in milliseconds', () => {
    expect(bgTaskTimeoutEnvEntry('claude', 600)).toEqual({ [CLAUDE_VAR]: '600000' })
    expect(bgTaskTimeoutEnvEntry('claude', 5)).toEqual({ [CLAUDE_VAR]: '5000' })
  })

  it('injects 0 unchanged (indefinite)', () => {
    expect(bgTaskTimeoutEnvEntry('claude', 0)).toEqual({ [CLAUDE_VAR]: '0' })
  })

  it('injects nothing for runners without a known env var', () => {
    expect(bgTaskTimeoutEnvEntry('amp', 600)).toEqual({})
    expect(bgTaskTimeoutEnvEntry('cursor', 600)).toEqual({})
  })

  it('never overrides a var the agent set by hand', () => {
    expect(bgTaskTimeoutEnvEntry('claude', 600, { [CLAUDE_VAR]: '123' })).toEqual({})
  })

  it('injects when the agent set unrelated env vars', () => {
    expect(bgTaskTimeoutEnvEntry('claude', 600, { FOO: 'bar' })).toEqual({ [CLAUDE_VAR]: '600000' })
  })
})
