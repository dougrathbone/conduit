import { describe, it, expect } from 'vitest'
import { resolveRunPublishMessage } from './publisher'

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
