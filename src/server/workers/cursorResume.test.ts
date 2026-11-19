import { describe, it, expect } from 'vitest'
import {
  CURSOR_RESUME_DELAYS_MS,
  DEFAULT_CURSOR_RESUME_MAX_ATTEMPTS,
  cursorResumeDelayMs,
  resolveCursorResumeMaxAttempts,
  shouldResumeCursor,
} from './cursorResume'

const RETRIABLE = 'RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)'

describe('shouldResumeCursor', () => {
  const base = {
    sessionId: 'sess-1',
    exitCode: 1 as number | null,
    stderrTail: `${RETRIABLE}\n`,
    attempt: 0,
    maxAttempts: 3,
  }

  it('resumes after a dropped provider connection', () => {
    expect(shouldResumeCursor(base)).toBe(true)
  })

  it('resumes on resource_exhausted too', () => {
    expect(shouldResumeCursor({ ...base, stderrTail: 'RetriableError: [resource_exhausted] Error' })).toBe(true)
  })

  it('needs a session to resume', () => {
    expect(shouldResumeCursor({ ...base, sessionId: undefined })).toBe(false)
  })

  it('does not resume a clean exit or a signal kill', () => {
    expect(shouldResumeCursor({ ...base, exitCode: 0 })).toBe(false)
    expect(shouldResumeCursor({ ...base, exitCode: null })).toBe(false)
  })

  it('does not resume other failures', () => {
    expect(shouldResumeCursor({ ...base, stderrTail: 'Error: something else broke' })).toBe(false)
    expect(shouldResumeCursor({ ...base, stderrTail: '' })).toBe(false)
  })

  it('judges by the last stderr line, not an earlier one', () => {
    expect(shouldResumeCursor({ ...base, stderrTail: `${RETRIABLE}\nError: fatal\n` })).toBe(false)
    expect(shouldResumeCursor({ ...base, stderrTail: `warning: x\n${RETRIABLE}\n\n` })).toBe(true)
  })

  it('stops once the attempts are used up', () => {
    expect(shouldResumeCursor({ ...base, attempt: 2 })).toBe(true)
    expect(shouldResumeCursor({ ...base, attempt: 3 })).toBe(false)
    expect(shouldResumeCursor({ ...base, maxAttempts: 0 })).toBe(false)
  })
})

describe('resolveCursorResumeMaxAttempts', () => {
  it('defaults when unset or invalid', () => {
    expect(resolveCursorResumeMaxAttempts({})).toBe(DEFAULT_CURSOR_RESUME_MAX_ATTEMPTS)
    expect(resolveCursorResumeMaxAttempts({ CONDUIT_CURSOR_RESUME_MAX_ATTEMPTS: 'x' })).toBe(
      DEFAULT_CURSOR_RESUME_MAX_ATTEMPTS
    )
    expect(resolveCursorResumeMaxAttempts({ CONDUIT_CURSOR_RESUME_MAX_ATTEMPTS: '-1' })).toBe(
      DEFAULT_CURSOR_RESUME_MAX_ATTEMPTS
    )
  })

  it('honours an explicit value, including 0 to disable', () => {
    expect(resolveCursorResumeMaxAttempts({ CONDUIT_CURSOR_RESUME_MAX_ATTEMPTS: '5' })).toBe(5)
    expect(resolveCursorResumeMaxAttempts({ CONDUIT_CURSOR_RESUME_MAX_ATTEMPTS: '0' })).toBe(0)
  })
})

describe('cursorResumeDelayMs', () => {
  it('backs off and repeats the last delay', () => {
    expect(cursorResumeDelayMs(1)).toBe(CURSOR_RESUME_DELAYS_MS[0])
    expect(cursorResumeDelayMs(2)).toBe(CURSOR_RESUME_DELAYS_MS[1])
    expect(cursorResumeDelayMs(99)).toBe(CURSOR_RESUME_DELAYS_MS[CURSOR_RESUME_DELAYS_MS.length - 1])
  })
})
