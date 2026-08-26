/**
 * Durable run-delivery log: sequenced NDJSON append/flush, contiguous cursor
 * derivation, and idempotent replay. Uses real temporary files (no mocks).
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  appendSequencedEvents,
  readHighestContiguousSequence,
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
