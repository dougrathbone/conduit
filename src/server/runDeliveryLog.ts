/**
 * Durable run-delivery log — the server-side persistence behind run-frame ACKs.
 *
 * A run's `logs/<runId>.jsonl` doubles as the delivery journal: every applied
 * remote frame tags its rows with `_deliverySequence`, so the highest contiguous
 * sequence in the file is the durable cursor a replacement process can resume
 * from without re-applying anything.
 *
 * Two properties matter as much as correctness:
 *
 * - **Bounded disk.** The same per-run cap the runner applies to its own writes
 *   (`CONDUIT_RUN_LOG_MAX_BYTES`) applies here. Past the cap the log stops
 *   growing, one truncation diagnostic is written, and the cursor keeps
 *   advancing in a single fixed-size sidecar (`<log>.cursor`) — never a marker
 *   row per frame — so delivery still completes and stays recoverable.
 * - **Bounded work per frame.** A writer keeps its cursor and byte count in
 *   memory, so the steady-state append costs one open/write/fsync. Only a
 *   recovery open scans the file, and that scan streams with a bounded line
 *   buffer instead of materializing the log as one string.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { RunEventInit } from '../shared/types'

/** Internal NDJSON metadata. Not part of the public RunEvent contract. */
export const DELIVERY_SEQUENCE_FIELD = '_deliverySequence'

/**
 * Longest line a cursor scan will assemble. A single pathological line (a
 * partially written gigabyte row, a corrupted file with no newlines) is skipped
 * rather than buffered, so scanning can never hit the V8 max string length.
 */
export const MAX_SCAN_LINE_BYTES = 4 * 1024 * 1024

/** Corrupt/oversized sidecars are ignored rather than parsed. */
const MAX_CURSOR_FILE_BYTES = 4096

const DEFAULT_RUN_LOG_MAX_BYTES = 500 * 1024 * 1024

/** Per-run on-disk log cap shared by the runner and the delivery log. `0` disables it. */
export function resolveRunLogMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CONDUIT_RUN_LOG_MAX_BYTES)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RUN_LOG_MAX_BYTES
}

/** Sidecar holding the post-cap durable cursor for a run log. */
export function deliveryCursorPath(logPath: string): string {
  return `${logPath}.cursor`
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sequenceOf(row: unknown): number | undefined {
  if (!isRecord(row)) return undefined
  const seq = row[DELIVERY_SEQUENCE_FIELD]
  return isPositiveSafeInteger(seq) ? seq : undefined
}

function truncationDiagnostic(maxBytes: number): string {
  return (
    JSON.stringify({
      t: Date.now(),
      kind: 'raw',
      stream: 'system',
      text:
        `[Conduit: run log truncated on disk — exceeded ${maxBytes}-byte cap. ` +
        `Live output continues and delivery keeps advancing.]`,
    }) + '\n'
  )
}

async function fileSize(logPath: string): Promise<number> {
  try {
    return (await fs.promises.stat(logPath)).size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
}

/** Append pre-serialized lines with an fsync, returning the bytes written. */
async function appendLines(logPath: string, lines: string): Promise<number> {
  const fd = await fs.promises.open(logPath, 'a')
  try {
    await fd.write(lines)
    await fd.sync()
  } finally {
    await fd.close()
  }
  return Buffer.byteLength(lines)
}

async function readCursorSidecar(logPath: string): Promise<number | undefined> {
  const target = deliveryCursorPath(logPath)
  let size: number
  try {
    size = (await fs.promises.stat(target)).size
  } catch {
    return undefined
  }
  if (size > MAX_CURSOR_FILE_BYTES) return undefined
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(target, 'utf8'))
    if (!isRecord(parsed) || parsed.capped !== true) return undefined
    return isPositiveSafeInteger(parsed.sequence) ? parsed.sequence : undefined
  } catch {
    return undefined
  }
}

/** Overwrite the sidecar atomically so a crash mid-write can't corrupt the cursor. */
async function writeCursorSidecar(logPath: string, sequence: number): Promise<void> {
  const target = deliveryCursorPath(logPath)
  const tmp = `${target}.tmp`
  const fd = await fs.promises.open(tmp, 'w')
  try {
    await fd.write(JSON.stringify({ sequence, capped: true }) + '\n')
    await fd.sync()
  } finally {
    await fd.close()
  }
  await fs.promises.rename(tmp, target)
}

/** Remove a run's cursor sidecar (log deletion / test cleanup). */
export async function deleteDeliveryCursor(logPath: string): Promise<void> {
  await fs.promises.rm(deliveryCursorPath(logPath), { force: true })
  await fs.promises.rm(`${deliveryCursorPath(logPath)}.tmp`, { force: true })
}

/**
 * Stream the log and return its highest contiguous delivery sequence plus its
 * size. Constant memory: lines are assembled in a bounded buffer, oversized
 * ones are discarded, and the cursor only ever advances by exactly one so no
 * per-sequence set is retained.
 */
export async function scanDeliveryLog(
  logPath: string
): Promise<{ cursor: number; bytes: number }> {
  const bytes = await fileSize(logPath)
  if (bytes === 0) return { cursor: 0, bytes }

  let cursor = 0
  let buffer = ''
  let overflowed = false

  const consume = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    let seq: number | undefined
    try {
      seq = sequenceOf(JSON.parse(trimmed))
    } catch {
      return // Malformed JSONL must not advance the cursor.
    }
    if (seq === cursor + 1) cursor = seq
  }

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(logPath, { encoding: 'utf8' })
    stream.on('data', (chunk) => {
      const text = chunk as string
      let start = 0
      while (true) {
        const nl = text.indexOf('\n', start)
        if (nl === -1) break
        const piece = text.slice(start, nl)
        start = nl + 1
        if (overflowed) {
          overflowed = false
          buffer = ''
          continue
        }
        consume(buffer + piece)
        buffer = ''
      }
      if (overflowed) return
      buffer += text.slice(start)
      if (buffer.length > MAX_SCAN_LINE_BYTES) {
        overflowed = true
        buffer = ''
      }
    })
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  if (!overflowed) consume(buffer)

  return { cursor, bytes }
}

/**
 * Highest contiguous sequence durably applied for a run: the log's contiguous
 * prefix, or the sidecar cursor when the log has been capped past it.
 */
export async function readHighestContiguousSequence(logPath: string): Promise<number> {
  const [scanned, sidecar] = await Promise.all([
    scanDeliveryLog(logPath),
    readCursorSidecar(logPath),
  ])
  return Math.max(scanned.cursor, sidecar ?? 0)
}

export type DeliveryAppendResult = 'appended' | 'capped' | 'duplicate' | 'rejected'

export interface DeliveryLogWriter {
  /** Highest contiguous sequence durably applied through this writer. */
  readonly cursor: number
  /** True once the log stopped growing; frames after this only move the cursor. */
  readonly capped: boolean
  /**
   * Durably apply one frame's events.
   * - `appended` — persisted and fsynced; the caller may ACK.
   * - `capped` — cursor advanced durably but events were not persisted (log at
   *   its byte cap); the caller may ACK and must still stream them live.
   * - `duplicate` — already applied; ACK without re-applying.
   * - `rejected` — invalid or gapped; do not ACK.
   */
  append(events: RunEventInit[], sequence: number): Promise<DeliveryAppendResult>
}

export interface OpenDeliveryLogOptions {
  /** Byte cap for the log file. Defaults to `resolveRunLogMaxBytes()`. `0` disables. */
  maxBytes?: number
  /**
   * Known durable cursor. Supplying it (e.g. `0` for a fresh assignment) skips
   * the recovery scan entirely; omit it to derive the cursor from the file.
   */
  cursor?: number
}

export type OpenDeliveryLog = (
  logPath: string,
  opts?: OpenDeliveryLogOptions
) => Promise<DeliveryLogWriter>

/** Open a per-run writer that owns its cursor and byte budget in memory. */
export async function openDeliveryLog(
  logPath: string,
  opts: OpenDeliveryLogOptions = {}
): Promise<DeliveryLogWriter> {
  const maxBytes = opts.maxBytes ?? resolveRunLogMaxBytes()
  await fs.promises.mkdir(path.dirname(logPath), { recursive: true })

  const sidecar = await readCursorSidecar(logPath)
  let cursor: number
  let bytes: number
  if (opts.cursor !== undefined) {
    cursor = Math.max(opts.cursor, sidecar ?? 0)
    bytes = await fileSize(logPath)
  } else {
    const scanned = await scanDeliveryLog(logPath)
    cursor = Math.max(scanned.cursor, sidecar ?? 0)
    bytes = scanned.bytes
  }

  let capped = sidecar !== undefined || (maxBytes > 0 && bytes >= maxBytes)
  // The sidecar is written whenever the cap is reached, so its presence proves
  // the diagnostic was already emitted — it can never be written twice.
  let diagnosticPending = capped && sidecar === undefined

  const append = async (
    events: RunEventInit[],
    sequence: number
  ): Promise<DeliveryAppendResult> => {
    if (!isPositiveSafeInteger(sequence)) return 'rejected'
    if (sequence <= cursor) return 'duplicate'
    if (sequence !== cursor + 1) return 'rejected'

    if (capped) {
      if (diagnosticPending) {
        await appendLines(logPath, truncationDiagnostic(maxBytes))
        diagnosticPending = false
      }
      await writeCursorSidecar(logPath, sequence)
      cursor = sequence
      return 'capped'
    }

    const now = Date.now()
    const lines =
      events.length === 0
        ? JSON.stringify({ [DELIVERY_SEQUENCE_FIELD]: sequence }) + '\n'
        : events
            .map(
              (event) =>
                JSON.stringify({ ...event, t: now, [DELIVERY_SEQUENCE_FIELD]: sequence }) + '\n'
            )
            .join('')

    bytes += await appendLines(logPath, lines)
    cursor = sequence

    if (maxBytes > 0 && bytes >= maxBytes) {
      capped = true
      diagnosticPending = false
      await appendLines(logPath, truncationDiagnostic(maxBytes))
      await writeCursorSidecar(logPath, cursor)
    }
    return 'appended'
  }

  return {
    get cursor() {
      return cursor
    },
    get capped() {
      return capped
    },
    append,
  }
}

/**
 * One-shot append that derives the cursor from the file first. Convenient for
 * seeding and one-off writes; the control-plane hot path holds an open
 * `DeliveryLogWriter` instead so it never rescans.
 */
export async function appendSequencedEvents(
  logPath: string,
  events: RunEventInit[],
  sequence: number
): Promise<DeliveryAppendResult> {
  const log = await openDeliveryLog(logPath)
  return log.append(events, sequence)
}
