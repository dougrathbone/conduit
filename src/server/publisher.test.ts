import { describe, it, expect } from 'vitest'
import {
  resolveRunPublishMessage,
  selectPublishContent,
  splitSlackSections,
  buildFailureNotice,
  SLACK_SECTION_MAX_CHARS,
} from './publisher'

const SUMMARY = [
  '## Run Summary — AIA-607: Hoist route prefetch above subdomain gate',
  '',
  'Moved RoutePrefetchBootstrap above the subdomain gate.',
].join('\n')

describe('resolveRunPublishMessage', () => {
  it('returns the full output when no publish markers are present', () => {
    const stdout = ':chart_with_upwards_trend: *FE-Perf loop — advanced AIA-389*\nJob: advance-PR'
    expect(resolveRunPublishMessage(stdout)).toBe(stdout)
  })

  it('extracts the canonical publish block and drops surrounding narration', () => {
    const stdout = [
      'Starting the FE-perf loop.',
      'Draft PR created.',
      '<!--CONDUIT:PUBLISH-->',
      SUMMARY,
      '<!--/CONDUIT:PUBLISH-->',
      'Iteration complete.',
    ].join('\n')
    expect(resolveRunPublishMessage(stdout)).toBe(SUMMARY)
  })

  it('treats a repeated opening tag as a closer (FE-perf loop leak)', () => {
    const stdout = [
      'Starting the FE-perf loop. I will validate tooling.',
      'Yarn install succeeded.',
      '<!--CONDUIT:PUBLISH-->',
      SUMMARY,
      '<!--CONDUIT:PUBLISH-->',
    ].join('\n')
    expect(resolveRunPublishMessage(stdout)).toBe(SUMMARY)
  })

  it('accepts CONDUIT:END as a closer (Sentrypede loop-30 leak)', () => {
    const stdout = [
      'Starting a Sentry Patrol iteration.',
      'Now emitting the Phase 6 Slack summary.',
      '<!--CONDUIT:PUBLISH-->',
      '### Sentrypede — loop 30 (2026-08-02)',
      '*Scan:* 0 new issues.',
      '<!--CONDUIT:END-->',
      'Iteration complete. Summary: no new Sentry issues warranted action.',
    ].join('\n')
    expect(resolveRunPublishMessage(stdout)).toBe(
      '### Sentrypede — loop 30 (2026-08-02)\n*Scan:* 0 new issues.'
    )
  })

  it('accepts slash-after-colon and HTML-escaped comment forms', () => {
    const escaped = [
      'narration',
      '&lt;!--CONDUIT:PUBLISH--&gt;',
      'escaped summary',
      '&lt;!--/CONDUIT:PUBLISH--&gt;',
    ].join('\n')
    expect(resolveRunPublishMessage(escaped)).toBe('escaped summary')

    const slashAfter = '<!--CONDUIT:PUBLISH-->\nslash close\n<!--CONDUIT:/PUBLISH-->'
    expect(resolveRunPublishMessage(slashAfter)).toBe('slash close')
  })

  it('is tolerant of whitespace and case in the markers', () => {
    const stdout = '<!-- conduit:publish -->\nspaced\n<!-- /CONDUIT:publish -->'
    expect(resolveRunPublishMessage(stdout)).toBe('spaced')
  })

  it('uses content after an unclosed opener instead of the full transcript', () => {
    const stdout = [
      'Starting the FE-perf loop.',
      'Let me babysit CI.',
      '<!--CONDUIT:PUBLISH-->',
      SUMMARY,
    ].join('\n')
    expect(resolveRunPublishMessage(stdout)).toBe(SUMMARY)
    expect(resolveRunPublishMessage(stdout)).not.toContain('Starting the FE-perf loop')
  })

  it('prefers the last non-empty open block when the prompt is quoted earlier', () => {
    const stdout = [
      'To publish, wrap the summary in:',
      '<!--CONDUIT:PUBLISH-->',
      'Your formatted summary here',
      '<!--/CONDUIT:PUBLISH-->',
      'Done. Real summary follows.',
      '<!--CONDUIT:PUBLISH-->',
      'actual summary',
      '<!--/CONDUIT:PUBLISH-->',
    ].join('\n')
    expect(resolveRunPublishMessage(stdout)).toBe('actual summary')
  })

  it('skips publishing when an opener is present but the block is empty', () => {
    expect(resolveRunPublishMessage('<!--CONDUIT:PUBLISH-->\n<!--/CONDUIT:PUBLISH-->')).toBeNull()
    expect(resolveRunPublishMessage('<!--CONDUIT:PUBLISH-->\n<!--CONDUIT:PUBLISH-->')).toBeNull()
    expect(resolveRunPublishMessage('')).toBeNull()
  })
})

describe('selectPublishContent', () => {
  it('uses the publish block when one was emitted', () => {
    const messages = ['Starting.', `Done.\n\n<!--CONDUIT:PUBLISH-->\n${SUMMARY}`]
    expect(selectPublishContent(messages, 'FE bot')).toBe(SUMMARY)
  })

  it('posts only the labelled last message, not the transcript, when no block was emitted', () => {
    const messages = ['Starting the FE-perf loop.', 'Let me babysit CI.', 'Stopped the noisy monitor.']
    const content = selectPublishContent(messages, 'FE bot')!
    expect(content).toContain('FE bot finished without a publish summary')
    expect(content).toContain('Stopped the noisy monitor.')
    expect(content).not.toContain('Starting the FE-perf loop.')
  })

  it('returns null when there is nothing to post', () => {
    expect(selectPublishContent([], 'FE bot')).toBeNull()
    expect(selectPublishContent(['  '], 'FE bot')).toBeNull()
  })
})

describe('splitSlackSections', () => {
  it('keeps short text as one section', () => {
    expect(splitSlackSections('hello\n\nworld')).toEqual(['hello\n\nworld'])
  })

  it('splits a single oversized paragraph on line boundaries', () => {
    const bullet = '- ' + 'x'.repeat(398)
    const paragraph = Array.from({ length: 20 }, () => bullet).join('\n')
    const sections = splitSlackSections(paragraph)
    expect(sections.length).toBeGreaterThan(1)
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(SLACK_SECTION_MAX_CHARS)
    expect(sections.join('\n')).toBe(paragraph)
  })

  it('hard-splits a single line longer than the section limit', () => {
    const line = 'y'.repeat(SLACK_SECTION_MAX_CHARS * 2 + 10)
    const sections = splitSlackSections(line)
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(SLACK_SECTION_MAX_CHARS)
    expect(sections.join('')).toBe(line)
  })
})

describe('buildFailureNotice', () => {
  it('names the agent, includes the reason, and links to the run', () => {
    const notice = buildFailureNotice(
      'FE bot',
      { id: 'run-1', agentId: 'agent-1', lastLine: '✗ Run process was killed (SIGKILL)' },
      'https://conduit.example'
    )
    expect(notice).toContain('*FE bot*')
    expect(notice).toContain('killed (SIGKILL)')
    expect(notice).toContain('<https://conduit.example/agents/agent-1/runs/run-1|View run>')
  })

  it('falls back to a generic reason when the run has no last line', () => {
    const notice = buildFailureNotice('FE bot', { id: 'r', agentId: 'a' }, 'http://localhost:7456')
    expect(notice).toContain('No failure reason was recorded')
  })
})
