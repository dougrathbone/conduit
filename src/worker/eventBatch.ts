import type { RunEventInit } from '../shared/types'
import type { WorkerRunEventMessage } from '../shared/workerControl'
import { WORKER_MAX_EVENT_BATCH, WORKER_MAX_MESSAGE_BYTES } from '../shared/workerControl'

/** Bytes reserved so the JSON envelope stays under the server frame cap. */
export const WORKER_EVENT_FRAME_HEADROOM = 16_384

/**
 * Split `run:event` payloads so each frame stays under the server batch and
 * byte limits. A single text event that exceeds the cap is split across
 * frames (order preserved). A non-text event that cannot fit is replaced
 * with a system marker under the cap — never an oversized frame.
 */
export function chunkRunEvents(
  runId: string,
  events: RunEventInit[],
  limits: { maxBatch?: number; maxBytes?: number } = {}
): WorkerRunEventMessage[] {
  const maxBatch = limits.maxBatch ?? WORKER_MAX_EVENT_BATCH
  const maxBytes = limits.maxBytes ?? WORKER_MAX_MESSAGE_BYTES - WORKER_EVENT_FRAME_HEADROOM
  const frames: WorkerRunEventMessage[] = []
  let batch: RunEventInit[] = []

  const frameSize = (evs: RunEventInit[]): number =>
    Buffer.byteLength(JSON.stringify({ type: 'run:event', runId, events: evs }))

  const flushBatch = (): void => {
    if (batch.length === 0) return
    frames.push({ type: 'run:event', runId, events: batch })
    batch = []
  }

  for (const incoming of events) {
    for (const ev of fitEvent(incoming, runId, maxBytes)) {
      const next = batch.length === 0 ? [ev] : [...batch, ev]
      if (batch.length > 0 && (next.length > maxBatch || frameSize(next) > maxBytes)) {
        flushBatch()
        batch = [ev]
        continue
      }
      batch = next
    }
  }
  flushBatch()
  return frames
}

function fitEvent(ev: RunEventInit, runId: string, maxBytes: number): RunEventInit[] {
  if (encodedSize(runId, [ev]) <= maxBytes) return [ev]
  if (typeof ev.text === 'string' && ev.text.length > 0) {
    return splitTextEvent(ev, runId, maxBytes)
  }
  return [oversizedMarker(ev)]
}

function splitTextEvent(ev: RunEventInit, runId: string, maxBytes: number): RunEventInit[] {
  const chunks: RunEventInit[] = []
  let remaining = ev.text ?? ''
  while (remaining.length > 0) {
    let lo = 1
    let hi = remaining.length
    let best = 0
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const candidate = { ...ev, text: remaining.slice(0, mid) }
      if (encodedSize(runId, [candidate]) <= maxBytes) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (best === 0) {
      chunks.push(oversizedMarker(ev))
      break
    }
    chunks.push({ ...ev, text: remaining.slice(0, best) })
    remaining = remaining.slice(best)
  }
  return chunks
}

function oversizedMarker(ev: RunEventInit): RunEventInit {
  return {
    kind: 'raw',
    stream: 'system',
    text: `[Conduit: dropped oversized ${ev.kind} event]`,
  }
}

function encodedSize(runId: string, events: RunEventInit[]): number {
  return Buffer.byteLength(JSON.stringify({ type: 'run:event', runId, events }))
}
