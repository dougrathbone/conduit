import type { RunEventInit } from '../shared/types'
import type { WorkerRunEventMessage } from '../shared/workerControl'
import { WORKER_MAX_EVENT_BATCH, WORKER_MAX_MESSAGE_BYTES } from '../shared/workerControl'

/** Bytes reserved so the JSON envelope stays under the server frame cap. */
export const WORKER_EVENT_FRAME_HEADROOM = 16_384

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

  for (const ev of events) {
    const next = batch.length === 0 ? [ev] : [...batch, ev]
    if (batch.length > 0 && (next.length > maxBatch || frameSize(next) > maxBytes)) {
      frames.push({ type: 'run:event', runId, events: batch })
      batch = [ev]
      continue
    }
    batch = next
  }
  if (batch.length > 0) {
    frames.push({ type: 'run:event', runId, events: batch })
  }
  return frames
}
