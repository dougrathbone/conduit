import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WORKER_RECONNECT_TIMEOUT_MS,
  WORKER_MAX_EVENT_BATCH,
  parseWorkerToServerMessage,
  resolveWorkerReconnectTimeoutMs,
  type ReliableRunFrame,
  type ServerRunAckMessage,
  type ServerRunRejectMessage,
  type ServerRunResumeMessage,
  type WorkerRunEventMessage,
  type WorkerRunExitMessage,
  type WorkerRunStartedMessage,
} from '../shared/workerControl'
import { createReliableDeliveryQueue } from './reliableDelivery'

function started(runId = 'run-1'): Omit<WorkerRunStartedMessage, 'sequence'> {
  return { type: 'run:started', runId }
}

function event(text: string, runId = 'run-1'): Omit<WorkerRunEventMessage, 'sequence'> {
  return { type: 'run:event', runId, events: [{ kind: 'raw', stream: 'stdout', text }] }
}

function exit(runId = 'run-1'): Omit<WorkerRunExitMessage, 'sequence'> {
  return { type: 'run:exit', runId, status: 'completed', exitCode: 0 }
}

function gatedSender(): {
  sent: ReliableRunFrame[]
  send: (frame: ReliableRunFrame) => Promise<void>
  release: () => void
} {
  const sent: ReliableRunFrame[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let first = true
  return {
    sent,
    release: () => release(),
    send: async (frame) => {
      sent.push(frame)
      if (first) {
        first = false
        await gate
      }
    },
  }
}

describe('resolveWorkerReconnectTimeoutMs', () => {
  it('falls back to 300_000 when CONDUIT_WORKER_RECONNECT_TIMEOUT_MS is missing or non-positive so tests cannot silently get a zero window', () => {
    expect(DEFAULT_WORKER_RECONNECT_TIMEOUT_MS).toBe(300_000)
    expect(resolveWorkerReconnectTimeoutMs({})).toBe(300_000)
    expect(resolveWorkerReconnectTimeoutMs({ CONDUIT_WORKER_RECONNECT_TIMEOUT_MS: '1250' })).toBe(1_250)
    expect(resolveWorkerReconnectTimeoutMs({ CONDUIT_WORKER_RECONNECT_TIMEOUT_MS: '0' })).toBe(300_000)
    expect(resolveWorkerReconnectTimeoutMs({ CONDUIT_WORKER_RECONNECT_TIMEOUT_MS: '-5' })).toBe(300_000)
    expect(resolveWorkerReconnectTimeoutMs({ CONDUIT_WORKER_RECONNECT_TIMEOUT_MS: 'nope' })).toBe(300_000)
  })
})

describe('reliable run-frame protocol', () => {
  it('parses pendingRunIds on worker:hello so a finished-but-unacked run can still be adopted', () => {
    const parsed = parseWorkerToServerMessage(
      JSON.stringify({
        type: 'worker:hello',
        workerId: 'w1',
        capabilities: { runners: ['claude'], version: '2' },
        activeRunIds: ['active'],
        pendingRunIds: ['pending'],
      })
    )
    expect(parsed).toEqual({
      ok: true,
      message: {
        type: 'worker:hello',
        workerId: 'w1',
        capabilities: { runners: ['claude'], version: '2' },
        activeRunIds: ['active'],
        pendingRunIds: ['pending'],
      },
    })
  })

  it('defaults missing pendingRunIds to [] so existing hellos stay valid', () => {
    const parsed = parseWorkerToServerMessage(
      JSON.stringify({
        type: 'worker:hello',
        workerId: 'w1',
        capabilities: { runners: ['claude'], version: '1' },
        activeRunIds: [],
      })
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok && parsed.message.type === 'worker:hello') {
      expect(parsed.message.pendingRunIds).toEqual([])
    }
  })

  it('rejects pendingRunIds that contain a non-string so a mixed array cannot look like a valid hello', () => {
    const parsed = parseWorkerToServerMessage(
      JSON.stringify({
        type: 'worker:hello',
        workerId: 'w1',
        capabilities: { runners: ['claude'], version: '2' },
        activeRunIds: [],
        pendingRunIds: ['run-1', 2],
      })
    )
    expect(parsed).toEqual({ ok: false, error: 'invalid' })
  })

  it('keeps a sequenced run:event payload and still rejects batches above WORKER_MAX_EVENT_BATCH', () => {
    const ok = parseWorkerToServerMessage(
      JSON.stringify({
        type: 'run:event',
        runId: 'run-1',
        sequence: 4,
        events: [{ kind: 'raw', stream: 'stdout', text: 'x' }],
      })
    )
    expect(ok).toEqual({
      ok: true,
      message: {
        type: 'run:event',
        runId: 'run-1',
        sequence: 4,
        events: [{ kind: 'raw', stream: 'stdout', text: 'x' }],
      },
    })

    const oversized = parseWorkerToServerMessage(
      JSON.stringify({
        type: 'run:event',
        runId: 'run-1',
        sequence: 1,
        events: Array.from({ length: WORKER_MAX_EVENT_BATCH + 1 }, () => ({ kind: 'raw' })),
      })
    )
    expect(oversized).toEqual({ ok: false, error: 'oversized-batch' })
  })

  it('rejects a non-positive or non-integer sequence so it cannot move a durable cursor', () => {
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      const parsed = parseWorkerToServerMessage(
        JSON.stringify({
          type: 'run:started',
          runId: 'run-1',
          sequence,
        })
      )
      expect(parsed).toEqual({ ok: false, error: 'invalid' })
    }
  })

  it('types server ack/resume/reject frames used to advance or refuse delivery', () => {
    const ack: ServerRunAckMessage = { type: 'run:ack', runId: 'run-1', sequence: 2 }
    const resume: ServerRunResumeMessage = { type: 'run:resume', runId: 'run-1', sequence: 2 }
    const reject: ServerRunRejectMessage = { type: 'run:reject', runId: 'run-1', reason: 'foreign-worker' }
    expect(ack).toMatchObject({ type: 'run:ack', sequence: 2 })
    expect(resume).toMatchObject({ type: 'run:resume', sequence: 2 })
    expect(reject).toMatchObject({ type: 'run:reject', reason: 'foreign-worker' })
  })
})

describe('ReliableDeliveryQueue', () => {
  it('preserves workspacePath and assignId on an enqueued run:started frame', () => {
    const queue = createReliableDeliveryQueue()
    const frame = queue.enqueue({
      type: 'run:started',
      runId: 'run-1',
      workspacePath: '/tmp/ws',
      assignId: 'assign-1',
    })
    expect(frame).toMatchObject({
      type: 'run:started',
      sequence: 1,
      workspacePath: '/tmp/ws',
      assignId: 'assign-1',
    })
  })

  it('allocates sequences once and drops only prefix frames covered by a contiguous ACK of sent frames', async () => {
    const queue = createReliableDeliveryQueue()
    queue.enqueue(started())
    queue.enqueue(event('a'))
    queue.enqueue(exit())

    expect(queue.pending().map((frame) => frame.sequence)).toEqual([1, 2, 3])
    await queue.drain(async () => {})
    queue.acknowledge(2)
    expect(queue.pending().map((frame) => frame.sequence)).toEqual([3])
    expect(queue.terminalAcknowledged).toBe(false)
    queue.acknowledge(3)
    expect(queue.pending()).toEqual([])
    expect(queue.terminalAcknowledged).toBe(true)
  })

  it('serializes drain so a second flush cannot send sequence N+1 before N finishes writing', async () => {
    const queue = createReliableDeliveryQueue()
    queue.enqueue(started())
    queue.enqueue(event('a'))
    queue.enqueue(exit())
    const { sent, send, release } = gatedSender()

    const first = queue.drain(send)
    await viWaitFor(() => sent.length === 1)
    const second = queue.drain(send)
    expect(sent.map((frame) => frame.sequence)).toEqual([1])
    release()
    await Promise.all([first, second])
    expect(sent.map((frame) => frame.sequence)).toEqual([1, 2, 3])
  })

  it('retains frames after a successful write until ACK so a lost application is replayable', async () => {
    const queue = createReliableDeliveryQueue()
    queue.enqueue(event('a'))
    queue.enqueue(event('b'))
    const sent: number[] = []
    await queue.drain(async (frame) => {
      sent.push(frame.sequence)
    })
    expect(sent).toEqual([1, 2])
    expect(queue.pending().map((frame) => frame.sequence)).toEqual([1, 2])
    queue.acknowledge(1)
    expect(queue.pending().map((frame) => frame.sequence)).toEqual([2])
  })

  it('replays only frames above the server resume cursor', async () => {
    const queue = createReliableDeliveryQueue()
    queue.enqueue(started())
    queue.enqueue(event('a'))
    queue.enqueue(exit())
    const sent: number[] = []
    await queue.drain(async (frame) => {
      sent.push(frame.sequence)
    })
    queue.resumeAfter(1)
    sent.length = 0
    await queue.drain(async (frame) => {
      sent.push(frame.sequence)
    })
    expect(sent).toEqual([2, 3])
    expect(queue.pending().map((frame) => frame.sequence)).toEqual([1, 2, 3])
  })

  it('ignores stale and duplicate ACKs so a late ack-1 cannot resurrect dropped prefix frames', async () => {
    const queue = createReliableDeliveryQueue()
    queue.enqueue(started())
    queue.enqueue(event('a'))
    queue.enqueue(exit())
    await queue.drain(async () => {})
    queue.acknowledge(2)
    queue.acknowledge(2)
    queue.acknowledge(1)
    expect(queue.pending().map((frame) => frame.sequence)).toEqual([3])
    expect(queue.terminalAcknowledged).toBe(false)
  })

  it('ignores an ACK beyond the highest successfully sent contiguous sequence so an unsent frame is not discarded', async () => {
    const queue = createReliableDeliveryQueue()
    queue.enqueue(started())
    queue.enqueue(event('a'))
    queue.enqueue(exit())
    queue.acknowledge(2)
    expect(queue.pending().map((frame) => frame.sequence)).toEqual([1, 2, 3])
    await queue.drain(async () => {})
    queue.acknowledge(2)
    expect(queue.pending().map((frame) => frame.sequence)).toEqual([3])
    queue.acknowledge(99)
    expect(queue.pending().map((frame) => frame.sequence)).toEqual([3])
    expect(queue.terminalAcknowledged).toBe(false)
  })

  it('ignores a resume cursor above the highest enqueued sequence so frames 1..terminal still drain', async () => {
    const queue = createReliableDeliveryQueue()
    queue.enqueue(started())
    queue.enqueue(event('a'))
    queue.enqueue(exit())
    queue.resumeAfter(99)
    const sent: number[] = []
    await queue.drain(async (frame) => {
      sent.push(frame.sequence)
    })
    expect(sent).toEqual([1, 2, 3])
    expect(queue.pending().map((frame) => frame.sequence)).toEqual([1, 2, 3])
  })

  it('does not skip a pending range when resumeAfter races an in-flight drain', async () => {
    const queue = createReliableDeliveryQueue()
    queue.enqueue(started())
    queue.enqueue(event('a'))
    queue.enqueue(exit())
    const sent: number[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const send = async (frame: ReliableRunFrame): Promise<void> => {
      sent.push(frame.sequence)
      if (frame.sequence === 3 && sent.filter((s) => s === 3).length === 1) {
        await gate
      }
    }

    const first = queue.drain(send)
    await viWaitFor(() => sent.length === 3)
    expect(sent).toEqual([1, 2, 3])
    queue.resumeAfter(0)
    const replay = queue.drain(send)
    release()
    await Promise.all([first, replay])
    expect(sent).toEqual([1, 2, 3, 1, 2, 3])
  })

  it('does not advance sentThrough when send rejects, so a later drain retries the unwritten frame', async () => {
    const queue = createReliableDeliveryQueue()
    queue.enqueue(started())
    queue.enqueue(event('a'))
    queue.enqueue(exit())
    const sent: number[] = []
    let attempts = 0
    const send = async (frame: ReliableRunFrame): Promise<void> => {
      attempts++
      if (attempts === 1) throw new Error('not written')
      sent.push(frame.sequence)
    }

    await expect(queue.drain(send)).rejects.toThrow('not written')
    expect(sent).toEqual([])
    await queue.drain(send)
    expect(sent).toEqual([1, 2, 3])
    expect(attempts).toBe(4)
  })
})

function viWaitFor(pred: () => boolean, ms = 200): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (pred()) {
        resolve()
        return
      }
      if (Date.now() - start > ms) {
        reject(new Error('waitFor timed out'))
        return
      }
      setTimeout(tick, 5)
    }
    tick()
  })
}
