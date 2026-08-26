import * as fs from 'fs'
import * as path from 'path'
import type { RunEventInit } from '../shared/types'

/** Internal NDJSON metadata. Not part of the public RunEvent contract. */
export const DELIVERY_SEQUENCE_FIELD = '_deliverySequence'

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function sequenceOf(row: unknown): number | undefined {
  if (!row || typeof row !== 'object') return undefined
  const seq = (row as { [DELIVERY_SEQUENCE_FIELD]?: unknown })[DELIVERY_SEQUENCE_FIELD]
  return isPositiveSafeInteger(seq) ? seq : undefined
}

async function readSequenceSet(logPath: string): Promise<Set<number>> {
  const sequences = new Set<number>()
  let raw: string
  try {
    raw = await fs.promises.readFile(logPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return sequences
    throw err
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const seq = sequenceOf(JSON.parse(trimmed))
      if (seq !== undefined) sequences.add(seq)
    } catch {
      // Malformed JSONL must not advance the cursor.
    }
  }
  return sequences
}

/** Highest N such that sequences 1..N are all present. Missing file or gaps → 0 or prefix. */
export async function readHighestContiguousSequence(logPath: string): Promise<number> {
  const sequences = await readSequenceSet(logPath)
  let n = 0
  while (sequences.has(n + 1)) n++
  return n
}

/**
 * Append events tagged with `sequence` and fsync before resolving.
 * Returns `duplicate` when the sequence is already in the contiguous prefix
 * (idempotent replay), `rejected` when it would skip a gap.
 */
export async function appendSequencedEvents(
  logPath: string,
  events: RunEventInit[],
  sequence: number
): Promise<'appended' | 'duplicate' | 'rejected'> {
  if (!isPositiveSafeInteger(sequence)) return 'rejected'
  await fs.promises.mkdir(path.dirname(logPath), { recursive: true })
  const highest = await readHighestContiguousSequence(logPath)
  if (sequence <= highest) return 'duplicate'
  if (sequence !== highest + 1) return 'rejected'

  const now = Date.now()
  const lines =
    events.length === 0
      ? [JSON.stringify({ [DELIVERY_SEQUENCE_FIELD]: sequence }) + '\n']
      : events.map(
          (event) => JSON.stringify({ ...event, t: now, [DELIVERY_SEQUENCE_FIELD]: sequence }) + '\n'
        )

  const fd = await fs.promises.open(logPath, 'a')
  try {
    await fd.write(lines.join(''))
    await fd.sync()
  } finally {
    await fd.close()
  }
  return 'appended'
}
