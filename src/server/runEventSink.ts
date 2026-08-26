import type { RunEvent, RunEventInit } from '../shared/types'
import type { WorkerEventSink } from '../shared/worker'

/**
 * Split the three things that happen to a run event so a sequenced
 * control-plane frame — already durably persisted by the delivery log — is not
 * written to the run's jsonl a second time, yet is still forwarded to the
 * platform log (stdout) and reflected in the live summary/broadcast.
 *
 * - `persist` — append to the run's own jsonl. Skipped for durable events.
 * - `forward` — emit to the process log for external log shipping. Always runs
 *   exactly once, whichever path delivered the event.
 * - `live` — update `lastLine` and the browser broadcast buffer.
 */
export function createRunEventHandlers(opts: {
  persist: (event: RunEvent) => void
  forward: (event: RunEvent) => void
  live: (event: RunEvent) => void
}): Required<Pick<WorkerEventSink, 'onEvent' | 'onDurableEvent'>> {
  const stamp = (init: RunEventInit): RunEvent => ({ ...init, t: Date.now() })
  return {
    onEvent: (init) => {
      const event = stamp(init)
      opts.persist(event)
      opts.forward(event)
      opts.live(event)
    },
    onDurableEvent: (init) => {
      const event = stamp(init)
      opts.forward(event)
      opts.live(event)
    },
  }
}
