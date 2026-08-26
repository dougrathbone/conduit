import type { RunEvent, RunEventInit } from '../shared/types'
import type { WorkerEventSink } from '../shared/worker'

/**
 * Split persist vs live observation so a sequenced control-plane append is not
 * followed by a second runner jsonl write for the same event.
 */
export function createRunEventHandlers(opts: {
  write: (event: RunEvent) => void
  live: (event: RunEvent) => void
}): Pick<WorkerEventSink, 'onEvent' | 'onDurableEvent'> {
  const stamp = (init: RunEventInit): RunEvent => ({ ...init, t: Date.now() })
  return {
    onEvent: (init) => {
      const event = stamp(init)
      opts.write(event)
      opts.live(event)
    },
    onDurableEvent: (init) => {
      opts.live(stamp(init))
    },
  }
}
