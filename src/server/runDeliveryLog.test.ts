/**
 * Durable run-delivery log: sequenced NDJSON append/flush, contiguous cursor
 * derivation, and idempotent replay. Uses real temporary files (no mocks).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  appendSequencedEvents,
  deliveryCursorPath,
  openDeliveryLog,
  readHighestContiguousSequence,
  resolveRunLogMaxBytes,
  MAX_SCAN_LINE_BYTES,
} from './runDeliveryLog'
import type { RunEventInit } from '../shared/types'

const ev = (text: string): RunEventInit => ({ kind: 'raw', stream: 'stdout', text })

function tmpLog(): { dir: string; logPath: string; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-delivery-log-'))
  return {
    dir,
    logPath: path.join(dir, 'run-1.jsonl'),
    close: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

function readLines(logPath: string): unknown[] {
  if (!fs.existsSync(logPath)) return []
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

function eventCountAt(logPath: string, sequence: number): number {
  return readLines(logPath).filter((row) => {
    if (!row || typeof row !== 'object') return false
    const rec = row as { _deliverySequence?: unknown; kind?: unknown }
    return rec._deliverySequence === sequence && typeof rec.kind === 'string'
  }).length
}

describe('run delivery log', () => {
  const temps: Array<{ close: () => void }> = []
  afterEach(() => {
    while (temps.length > 0) temps.pop()!.close()
  })

  it('returns the highest contiguous sequence after reopening a flushed log of events 1 and 2', async () => {
    const tmp = tmpLog()
    temps.push(tmp)

    expect(await appendSequencedEvents(tmp.logPath, [ev('one')], 1)).toBe('appended')
    expect(await appendSequencedEvents(tmp.logPath, [ev('two')], 2)).toBe('appended')

    expect(await readHighestContiguousSequence(tmp.logPath)).toBe(2)

    const reopened = path.join(tmp.dir, 'run-1.jsonl')
    expect(await readHighestContiguousSequence(reopened)).toBe(2)
    expect(fs.readFileSync(reopened, 'utf8')).toContain('one')
    expect(fs.readFileSync(reopened, 'utf8')).toContain('two')
  })

  it('does not advance the cursor for malformed JSON or legacy lines that lack delivery sequence metadata', async () => {
    const tmp = tmpLog()
    temps.push(tmp)

    expect(await appendSequencedEvents(tmp.logPath, [ev('one')], 1)).toBe('appended')
    expect(await appendSequencedEvents(tmp.logPath, [ev('two')], 2)).toBe('appended')

    fs.appendFileSync(
      tmp.logPath,
      '{not-json\n' +
        JSON.stringify({ t: 1, kind: 'raw', stream: 'system', text: 'legacy-no-seq' }) +
        '\n' +
        JSON.stringify({ t: 2, chunk: 'old-ansi-log', stream: 'stdout' }) +
        '\n' +
        JSON.stringify({ _deliverySequence: 'nope', kind: 'raw', text: 'bad-seq' }) +
        '\n'
    )

    expect(await readHighestContiguousSequence(tmp.logPath)).toBe(2)
  })

  it('does not append a second event when sequence 2 is replayed', async () => {
    const tmp = tmpLog()
    temps.push(tmp)

    expect(await appendSequencedEvents(tmp.logPath, [ev('one')], 1)).toBe('appended')
    expect(await appendSequencedEvents(tmp.logPath, [ev('two')], 2)).toBe('appended')
    expect(eventCountAt(tmp.logPath, 2)).toBe(1)

    expect(await appendSequencedEvents(tmp.logPath, [ev('two-again')], 2)).toBe('duplicate')
    expect(eventCountAt(tmp.logPath, 2)).toBe(1)
    expect(fs.readFileSync(tmp.logPath, 'utf8')).not.toContain('two-again')
    expect(await readHighestContiguousSequence(tmp.logPath)).toBe(2)
  })

  it('rejects sequence 4 while sequence 3 is absent and does not advance the cursor', async () => {
    const tmp = tmpLog()
    temps.push(tmp)

    expect(await appendSequencedEvents(tmp.logPath, [ev('one')], 1)).toBe('appended')
    expect(await appendSequencedEvents(tmp.logPath, [ev('two')], 2)).toBe('appended')

    expect(await appendSequencedEvents(tmp.logPath, [ev('four')], 4)).toBe('rejected')
    expect(await readHighestContiguousSequence(tmp.logPath)).toBe(2)
    expect(fs.readFileSync(tmp.logPath, 'utf8')).not.toContain('four')
  })

  it('returns 0 for a missing log so resume cannot invent a cursor above an empty spool', async () => {
    const tmp = tmpLog()
    temps.push(tmp)
    expect(await readHighestContiguousSequence(tmp.logPath)).toBe(0)
  })
})

describe('run delivery log per-run byte cap', () => {
  const temps: Array<{ close: () => void }> = []
  afterEach(() => {
    while (temps.length > 0) temps.pop()!.close()
  })

  const bigEvent = (n: number): RunEventInit => ev(`payload-${n}-${'x'.repeat(200)}`)

  it('resolves the cap from the same env var the runner uses and falls back to 500MB', () => {
    expect(resolveRunLogMaxBytes({ CONDUIT_RUN_LOG_MAX_BYTES: '2048' })).toBe(2048)
    expect(resolveRunLogMaxBytes({ CONDUIT_RUN_LOG_MAX_BYTES: '0' })).toBe(0)
    expect(resolveRunLogMaxBytes({ CONDUIT_RUN_LOG_MAX_BYTES: 'nope' })).toBe(500 * 1024 * 1024)
    expect(resolveRunLogMaxBytes({})).toBe(500 * 1024 * 1024)
  })

  it('stops growing the log past the cap, writes one truncation diagnostic, and still advances the durable cursor', async () => {
    const tmp = tmpLog()
    temps.push(tmp)
    const log = await openDeliveryLog(tmp.logPath, { maxBytes: 600, cursor: 0 })

    const results: string[] = []
    const sizes: number[] = []
    for (let seq = 1; seq <= 12; seq++) {
      results.push(await log.append([bigEvent(seq)], seq))
      sizes.push(fs.statSync(tmp.logPath).size)
    }

    expect(results[0]).toBe('appended')
    expect(results.at(-1)).toBe('capped')
    expect(log.cursor).toBe(12)
    expect(log.capped).toBe(true)

    // Once capped the file stops growing entirely, however many frames follow.
    const cappedFrom = results.indexOf('capped')
    expect(cappedFrom).toBeGreaterThan(0)
    expect(new Set(sizes.slice(cappedFrom)).size).toBe(1)
    expect(sizes.at(-1)).toBeLessThan(600 * 3)

    const text = fs.readFileSync(tmp.logPath, 'utf8')
    expect(text.match(/run log truncated on disk/g)).toHaveLength(1)
    expect(text).not.toContain('payload-12-')
    expect(await readHighestContiguousSequence(tmp.logPath)).toBe(12)
  })

  it('keeps the post-cap cursor in one bounded sidecar file rather than a marker per frame', async () => {
    const tmp = tmpLog()
    temps.push(tmp)
    const log = await openDeliveryLog(tmp.logPath, { maxBytes: 300, cursor: 0 })
    for (let seq = 1; seq <= 40; seq++) await log.append([bigEvent(seq)], seq)

    const sidecar = deliveryCursorPath(tmp.logPath)
    expect(fs.existsSync(sidecar)).toBe(true)
    expect(fs.statSync(sidecar).size).toBeLessThan(128)
    expect(JSON.parse(fs.readFileSync(sidecar, 'utf8'))).toMatchObject({ sequence: 40, capped: true })

    const lines = readLines(tmp.logPath)
    expect(lines.length).toBeLessThan(10)
  })

  it('recovers the capped cursor after reopening and does not repeat the diagnostic', async () => {
    const tmp = tmpLog()
    temps.push(tmp)
    const first = await openDeliveryLog(tmp.logPath, { maxBytes: 300, cursor: 0 })
    for (let seq = 1; seq <= 6; seq++) await first.append([bigEvent(seq)], seq)
    expect(first.capped).toBe(true)

    const reopened = await openDeliveryLog(tmp.logPath, { maxBytes: 300 })
    expect(reopened.cursor).toBe(6)
    expect(reopened.capped).toBe(true)
    expect(await reopened.append([bigEvent(6)], 6)).toBe('duplicate')
    expect(await reopened.append([bigEvent(7)], 7)).toBe('capped')
    expect(reopened.cursor).toBe(7)
    expect(await readHighestContiguousSequence(tmp.logPath)).toBe(7)
    expect(
      fs.readFileSync(tmp.logPath, 'utf8').match(/run log truncated on disk/g)
    ).toHaveLength(1)
  })

  it('treats maxBytes 0 as uncapped', async () => {
    const tmp = tmpLog()
    temps.push(tmp)
    const log = await openDeliveryLog(tmp.logPath, { maxBytes: 0, cursor: 0 })
    for (let seq = 1; seq <= 5; seq++) expect(await log.append([bigEvent(seq)], seq)).toBe('appended')
    expect(log.capped).toBe(false)
    expect(fs.existsSync(deliveryCursorPath(tmp.logPath))).toBe(false)
  })
})

describe('run delivery log cursor scanning', () => {
  const temps: Array<{ close: () => void }> = []
  afterEach(() => {
    vi.restoreAllMocks()
    while (temps.length > 0) temps.pop()!.close()
  })

  it('never re-reads the log while appending on the hot path', async () => {
    const tmp = tmpLog()
    temps.push(tmp)
    const log = await openDeliveryLog(tmp.logPath, { maxBytes: 0, cursor: 0 })

    const readFile = vi.spyOn(fs.promises, 'readFile')
    const stat = vi.spyOn(fs.promises, 'stat')
    for (let seq = 1; seq <= 25; seq++) {
      expect(await log.append([ev(`line-${seq}`)], seq)).toBe('appended')
    }

    expect(readFile).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(log.cursor).toBe(25)
  })

  it('appends against the known cursor even when the file on disk says otherwise', async () => {
    const tmp = tmpLog()
    temps.push(tmp)
    // Rows the writer never saw. A rescanning append would call sequence 1 a
    // duplicate; a writer trusting its known cursor appends it.
    for (let seq = 1; seq <= 5; seq++) {
      fs.appendFileSync(
        tmp.logPath,
        JSON.stringify({ kind: 'raw', stream: 'stdout', text: 'foreign', _deliverySequence: seq }) +
          '\n'
      )
    }
    const log = await openDeliveryLog(tmp.logPath, { maxBytes: 0, cursor: 0 })
    expect(log.cursor).toBe(0)
    expect(await log.append([ev('mine')], 1)).toBe('appended')
    expect(await log.append([ev('mine')], 1)).toBe('duplicate')
    expect(await log.append([ev('gapped')], 4)).toBe('rejected')
  })

  it('derives the recovery cursor by streaming, not by reading the whole file into a string', async () => {
    const tmp = tmpLog()
    temps.push(tmp)
    const seed = await openDeliveryLog(tmp.logPath, { maxBytes: 0, cursor: 0 })
    for (let seq = 1; seq <= 30; seq++) await seed.append([ev(`line-${seq}`)], seq)

    const readFile = vi.spyOn(fs.promises, 'readFile')
    expect(await readHighestContiguousSequence(tmp.logPath)).toBe(30)
    for (const call of readFile.mock.calls) {
      expect(String(call[0])).toBe(deliveryCursorPath(tmp.logPath))
    }
  })

  it('skips a line larger than the scan bound without failing the cursor derivation', async () => {
    const tmp = tmpLog()
    temps.push(tmp)
    const seed = await openDeliveryLog(tmp.logPath, { maxBytes: 0, cursor: 0 })
    await seed.append([ev('one')], 1)
    fs.appendFileSync(tmp.logPath, 'y'.repeat(MAX_SCAN_LINE_BYTES + 1024) + '\n')
    await seed.append([ev('two')], 2)

    expect(await readHighestContiguousSequence(tmp.logPath)).toBe(2)
  })

  it('stays bounded when a single malformed line is very large', async () => {
    const tmp = tmpLog()
    temps.push(tmp)
    fs.writeFileSync(tmp.logPath, '{"broken":' + 'z'.repeat(3 * 1024 * 1024) + '\n')
    fs.appendFileSync(
      tmp.logPath,
      JSON.stringify({ kind: 'raw', stream: 'stdout', text: 'ok', _deliverySequence: 1 }) + '\n'
    )
    expect(await readHighestContiguousSequence(tmp.logPath)).toBe(1)
  })
})
