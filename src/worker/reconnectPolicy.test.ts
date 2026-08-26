import { afterEach, describe, expect, it, vi } from 'vitest'
import { planAfterRunExit } from './oneShot'
import { createEventFlushQueue } from './eventFlush'
import { createReliableDeliveryQueue } from './reliableDelivery'
import type { ReliableRunFrame } from '../shared/workerControl'
import { MAX_TIMER_DELAY_MS } from '../shared/workerControl'
import {
  createReconnectPolicy,
  createRejectedRunLedger,
  expireDeliveryRecovery,
  hasPendingDelivery,
  holdAllSends,
  installUnlessRejected,
  pendingRunIds,
  recordLocalExit,
  rejectAssignedRun,
  replayFromCursor,
  applyDeliveryAck,
  shouldShutdownAfterDelivery,
  shutdownExitCode,
} from './reconnectPolicy'

afterEach(() => {
  vi.useRealTimers()
})

function started(runId: string) {
  return { type: 'run:started' as const, runId }
}

function event(runId: string, text: string) {
  return { type: 'run:event' as const, runId, events: [{ kind: 'raw' as const, stream: 'stdout' as const, text }] }
}

function exit(runId: string) {
  return { type: 'run:exit' as const, runId, status: 'completed' as const, exitCode: 0 }
}

function injectedClock() {
  return {
    now: () => Date.now(),
    setTimeout,
    clearTimeout,
  }
}

describe('ReconnectPolicy backoff', () => {
  it('retries with delays of 1000, 2000, 4000 milliseconds and caps at 30000', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const reconnects: number[] = []
    const policy = createReconnectPolicy({ timeoutMs: 300_000, clock: injectedClock() })
    const connect = (): void => {
      reconnects.push(Date.now())
      policy.noteOpen()
      policy.noteDisconnect()
      policy.scheduleReconnect(connect, () => {
        throw new Error('deadline should not expire in this test')
      })
    }

    policy.noteDisconnect(['run-1'])
    policy.scheduleReconnect(connect, () => {
      throw new Error('deadline should not expire in this test')
    })

    vi.advanceTimersByTime(999)
    expect(reconnects).toEqual([])
    vi.advanceTimersByTime(1)
    expect(reconnects).toEqual([1000])

    vi.advanceTimersByTime(1999)
    expect(reconnects).toEqual([1000])
    vi.advanceTimersByTime(1)
    expect(reconnects).toEqual([1000, 3000])

    vi.advanceTimersByTime(4000)
    expect(reconnects).toEqual([1000, 3000, 7000])

    vi.advanceTimersByTime(8000)
    expect(reconnects).toEqual([1000, 3000, 7000, 15000])

    vi.advanceTimersByTime(16000)
    expect(reconnects).toEqual([1000, 3000, 7000, 15000, 31000])

    vi.advanceTimersByTime(30000)
    expect(reconnects).toEqual([1000, 3000, 7000, 15000, 31000, 61000])

    vi.advanceTimersByTime(30000)
    expect(reconnects).toEqual([1000, 3000, 7000, 15000, 31000, 61000, 91000])

    policy.cancel()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('ReconnectPolicy outage deadline', () => {
  it('does not reset the original outage deadline on a successful TCP/WebSocket open without run:resume or covering ACK', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const policy = createReconnectPolicy({ timeoutMs: 5_000, clock: injectedClock() })
    policy.noteDisconnect(['run-1'])
    expect(policy.isExpired()).toBe(false)

    vi.advanceTimersByTime(1_000)
    policy.noteOpen()
    expect(policy.isExpired()).toBe(false)

    vi.advanceTimersByTime(3_999)
    expect(policy.isExpired()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(policy.isExpired()).toBe(true)
  })

  it('invokes expiry instead of reconnecting once the original disconnect deadline elapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const policy = createReconnectPolicy({ timeoutMs: 500, clock: injectedClock() })
    const reconnects: number[] = []
    const expiries: number[] = []
    policy.noteDisconnect(['run-1'])
    policy.scheduleReconnect(
      () => reconnects.push(Date.now()),
      () => expiries.push(Date.now())
    )
    vi.advanceTimersByTime(500)
    expect(reconnects).toEqual([])
    expect(expiries).toEqual([500])
    policy.cancel()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts a new deadline only after run:resume or a covering ACK, not after a bare socket open', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const policy = createReconnectPolicy({ timeoutMs: 5_000, clock: injectedClock() })
    policy.noteDisconnect(['run-1'])
    vi.advanceTimersByTime(2_000)
    policy.noteOpen()
    policy.noteHandled('run-1')
    policy.noteDisconnect(['run-1'])
    vi.advanceTimersByTime(4_999)
    expect(policy.isExpired()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(policy.isExpired()).toBe(true)
  })

  it('resets the outage only after every pending run is resumed or terminally handled', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const policy = createReconnectPolicy({ timeoutMs: 5_000, clock: injectedClock() })
    policy.noteDisconnect(['run-a', 'run-b'])
    policy.noteHandled('run-a')
    vi.advanceTimersByTime(1_000)
    expect(policy.isExpired()).toBe(false)
    policy.noteHandled('run-b')
    policy.noteDisconnect(['run-c'])
    vi.advanceTimersByTime(4_999)
    expect(policy.isExpired()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(policy.isExpired()).toBe(true)
  })

  it('fires the deadline while the worker is connected, not only from reconnect scheduling', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const expiries: number[] = []
    const policy = createReconnectPolicy({
      timeoutMs: 1_000,
      clock: injectedClock(),
      onExpired: () => expiries.push(Date.now()),
    })

    policy.noteDisconnect(['run-1'])
    // Reconnected successfully but the server never resumed or rejected the run.
    policy.noteOpen()
    vi.advanceTimersByTime(999)
    expect(expiries).toEqual([])
    vi.advanceTimersByTime(1)
    expect(expiries).toEqual([1_000])
    policy.cancel()
  })

  it('does not fire the connected deadline once every pending run is handled', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const expiries: number[] = []
    const policy = createReconnectPolicy({
      timeoutMs: 1_000,
      clock: injectedClock(),
      onExpired: () => expiries.push(Date.now()),
    })

    policy.noteDisconnect(['run-1'])
    policy.noteOpen()
    vi.advanceTimersByTime(500)
    policy.noteHandled('run-1')
    vi.advanceTimersByTime(5_000)
    expect(expiries).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-arms the connected deadline when an assignment supplies a new window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const expiries: number[] = []
    const policy = createReconnectPolicy({
      timeoutMs: 10_000,
      clock: injectedClock(),
      onExpired: () => expiries.push(Date.now()),
    })

    policy.noteDisconnect(['run-1'])
    policy.setTimeoutMs(2_000)
    vi.advanceTimersByTime(1_999)
    expect(expiries).toEqual([])
    vi.advanceTimersByTime(1)
    expect(expiries).toEqual([2_000])
    policy.cancel()
  })

  it('clamps an oversized window to the maximum timer delay instead of firing immediately', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const expiries: number[] = []
    const policy = createReconnectPolicy({
      timeoutMs: Number.MAX_SAFE_INTEGER,
      clock: injectedClock(),
      onExpired: () => expiries.push(Date.now()),
    })
    policy.noteDisconnect(['run-1'])
    expect(policy.remainingMs()).toBe(MAX_TIMER_DELAY_MS)
    vi.advanceTimersByTime(60_000)
    expect(expiries).toEqual([])
    policy.cancel()
  })
})

describe('rejected run ledger', () => {
  it('cancels a handle that is installed after the reject arrived, so nothing leaks', async () => {
    const ledger = createRejectedRunLedger()
    ledger.reject('run-late')
    expect(ledger.isRejected('run-late')).toBe(true)

    const cancelled: string[] = []
    const handles = new Map<string, { cancel(): Promise<void> }>()
    const handle = {
      cancel: async (): Promise<void> => {
        cancelled.push('run-late')
      },
    }
    const kept = await installUnlessRejected(ledger, 'run-late', handle, handles)

    expect(kept).toBe(false)
    expect(cancelled).toEqual(['run-late'])
    expect(handles.has('run-late')).toBe(false)
    expect(ledger.isRejected('run-late')).toBe(false)
  })

  it('keeps a handle for a run that was never rejected', async () => {
    const ledger = createRejectedRunLedger()
    const handles = new Map<string, { cancel(): Promise<void> }>()
    const handle = { cancel: async (): Promise<void> => {} }
    expect(await installUnlessRejected(ledger, 'run-ok', handle, handles)).toBe(true)
    expect(handles.get('run-ok')).toBe(handle)
  })

  it('bounds retained reject ids so a hostile server cannot grow worker memory', () => {
    const ledger = createRejectedRunLedger(4)
    for (let i = 0; i < 50; i++) ledger.reject(`run-${i}`)
    expect(ledger.size).toBe(4)
    expect(ledger.isRejected('run-49')).toBe(true)
    expect(ledger.isRejected('run-0')).toBe(false)
  })
})

describe('shutdown exit codes', () => {
  it('exits non-zero when delivery was rejected or lost, and zero on clean delivery', () => {
    expect(shutdownExitCode({ deliveryExpired: false })).toBe(0)
    expect(shutdownExitCode({ deliveryExpired: true })).toBe(1)
  })
})

describe('pendingRunIds', () => {
  it('reports the union of active and pending-delivery run IDs so a finished-but-unacked run can still be adopted', () => {
    const active = createReliableDeliveryQueue()
    active.enqueue(started('active-run'))
    const finished = createReliableDeliveryQueue()
    finished.enqueue(started('finished-but-unacked-run'))
    finished.enqueue(exit('finished-but-unacked-run'))
    const deliveryQueues = new Map([
      ['active-run', active],
      ['finished-but-unacked-run', finished],
    ])

    expect(pendingRunIds(['active-run'], deliveryQueues)).toEqual([
      'active-run',
      'finished-but-unacked-run',
    ])
  })
})

describe('local exit and ACK-gated shutdown', () => {
  it('enqueues run:exit after prior events when local process exit is recorded', async () => {
    const delivery = createReliableDeliveryQueue()
    const events = createEventFlushQueue({
      runId: 'run-1',
      delivery,
      send: async () => {},
    })
    delivery.enqueue(started('run-1'))
    events.push({ kind: 'raw', stream: 'stdout', text: 'log' })
    await recordLocalExit(events, delivery, {
      type: 'run:exit',
      runId: 'run-1',
      status: 'completed',
      exitCode: 0,
    })
    expect(delivery.pending().map((frame) => frame.type)).toEqual(['run:started', 'run:event', 'run:exit'])
  })

  it('blocks one-shot shutdown until the terminal sequence is ACKed', async () => {
    const oneShot = { CONDUIT_WORKER_ONE_SHOT: 'true' }
    const delivery = createReliableDeliveryQueue()
    const events = createEventFlushQueue({
      runId: 'run-1',
      delivery,
      send: async () => {},
    })
    const queues = new Map([['run-1', delivery]])
    delivery.enqueue(started('run-1'))
    await recordLocalExit(events, delivery, exit('run-1'))
    await delivery.drain(async () => {})

    expect(hasPendingDelivery(queues)).toBe(true)
    expect(planAfterRunExit(oneShot, { hasPendingDelivery: hasPendingDelivery(queues) })).toBe('idle')

    delivery.acknowledge(2)
    expect(hasPendingDelivery(queues)).toBe(false)
    expect(planAfterRunExit(oneShot, { hasPendingDelivery: hasPendingDelivery(queues) })).toBe('exit')
    expect(shutdownExitCode({ deliveryExpired: false })).toBe(0)
  })

  it('cancels active handles and selects exit code 1 when delivery recovery expires', async () => {
    const cancelled: string[] = []
    const handles = new Map([
      [
        'active-run',
        {
          cancel: async (): Promise<void> => {
            cancelled.push('active-run')
          },
        },
      ],
    ])
    const active = createReliableDeliveryQueue()
    active.enqueue(started('active-run'))
    const finished = createReliableDeliveryQueue()
    finished.enqueue(started('finished-but-unacked-run'))
    finished.enqueue(exit('finished-but-unacked-run'))
    const queues = new Map([
      ['active-run', active],
      ['finished-but-unacked-run', finished],
    ])

    const result = await expireDeliveryRecovery({
      handles,
      pendingRunIds: pendingRunIds(handles.keys(), queues),
    })
    expect(cancelled).toEqual(['active-run'])
    expect(result.exitCode).toBe(1)
    expect(result.pendingRunIds).toEqual(['active-run', 'finished-but-unacked-run'])
    expect(shutdownExitCode({ deliveryExpired: true })).toBe(1)
  })

  it('permits normal exit code 0 after a covering ACK of the terminal frame', async () => {
    const delivery = createReliableDeliveryQueue()
    delivery.enqueue(started('run-1'))
    delivery.enqueue(exit('run-1'))
    await delivery.drain(async () => {})
    delivery.acknowledge(2)
    expect(delivery.terminalAcknowledged).toBe(true)
    expect(shutdownExitCode({ deliveryExpired: false })).toBe(0)
    expect(
      planAfterRunExit({ CONDUIT_WORKER_ONE_SHOT: 'true' }, { hasPendingDelivery: !delivery.terminalAcknowledged })
    ).toBe('exit')
  })

  it('reconnect drain never sends event sequence N+1 before N', async () => {
    const delivery = createReliableDeliveryQueue()
    delivery.enqueue(started('run-1'))
    delivery.enqueue(event('run-1', 'a'))
    delivery.enqueue(event('run-1', 'b'))
    await delivery.drain(async () => {})

    const sent: number[] = []
    let inFlight: number | null = null
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const send = async (frame: ReliableRunFrame): Promise<void> => {
      expect(inFlight).toBeNull()
      inFlight = frame.sequence
      sent.push(frame.sequence)
      if (first) {
        first = false
        await gate
      }
      inFlight = null
    }

    const firstDrain = replayFromCursor(delivery, 0, send)
    await viWaitFor(() => sent.length === 1)
    const secondDrain = delivery.drain(send)
    expect(sent).toEqual([1])
    expect(inFlight).toBe(1)
    release()
    await Promise.all([firstDrain, secondDrain])
    expect(sent).toEqual([1, 2, 3])
  })

  it('holds reconnect drain until run:resume so a new socket does not skip the server cursor', async () => {
    const delivery = createReliableDeliveryQueue()
    delivery.enqueue(started('run-1'))
    delivery.enqueue(event('run-1', 'a'))
    await delivery.drain(async () => {})
    holdAllSends(new Map([['run-1', delivery]]))
    const sent: number[] = []
    await delivery.drain(async (frame) => {
      sent.push(frame.sequence)
    })
    expect(sent).toEqual([])
    expect(delivery.pending().map((frame) => frame.sequence)).toEqual([1, 2])
    await expect(
      replayFromCursor(delivery, 1, async (frame) => {
        sent.push(frame.sequence)
      })
    ).resolves.toBe(true)
    expect(sent).toEqual([2])
  })

  it('reports a rejected resume cursor so an unusable resume does not count as adoption', async () => {
    const delivery = createReliableDeliveryQueue()
    delivery.enqueue(started('run-1'))
    holdAllSends(new Map([['run-1', delivery]]))
    const sent: number[] = []

    const accepted = await replayFromCursor(delivery, 42, async (frame) => {
      sent.push(frame.sequence)
    })

    expect(accepted).toBe(false)
    expect(sent).toEqual([])
  })
})

describe('pooled-worker outage adoption', () => {
  it('does not reset the worker-wide deadline when only run A resumes and run B is still pending', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const policy = createReconnectPolicy({ timeoutMs: 5_000, clock: injectedClock() })
    policy.noteDisconnect(['run-a', 'run-b'])
    vi.advanceTimersByTime(1_000)
    policy.noteOpen()
    policy.noteHandled('run-a')
    vi.advanceTimersByTime(3_999)
    expect(policy.isExpired()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(policy.isExpired()).toBe(true)
  })

  it('does not reset the outage deadline on a stale or non-covering ACK', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const policy = createReconnectPolicy({ timeoutMs: 5_000, clock: injectedClock() })
    const a = createReliableDeliveryQueue()
    a.enqueue(started('run-a'))
    a.enqueue(event('run-a', 'x'))
    const b = createReliableDeliveryQueue()
    b.enqueue(started('run-b'))
    await a.drain(async () => {})
    policy.noteDisconnect(['run-a', 'run-b'])
    policy.noteOpen()
    expect(applyDeliveryAck(a, 1)).toBe('prefix')
    expect(applyDeliveryAck(a, 1)).toBe('ignored')
    expect(a.terminalAcknowledged).toBe(false)
    vi.advanceTimersByTime(5_000)
    expect(policy.isExpired()).toBe(true)
    expect(b.pending().map((frame) => frame.sequence)).toEqual([1])
  })

  it('resets the outage only after every pending run is resumed or terminally handled', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const policy = createReconnectPolicy({ timeoutMs: 5_000, clock: injectedClock() })
    policy.noteDisconnect(['run-a', 'run-b'])
    policy.noteHandled('run-a')
    vi.advanceTimersByTime(1_000)
    expect(policy.isExpired()).toBe(false)
    policy.noteHandled('run-b')
    policy.noteDisconnect(['run-c'])
    vi.advanceTimersByTime(4_999)
    expect(policy.isExpired()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(policy.isExpired()).toBe(true)
  })
})

describe('run:reject terminal handling', () => {
  it('removes a rejected run, cancels its handle, and allows one-shot exit once no pending delivery remains', async () => {
    const oneShot = { CONDUIT_WORKER_ONE_SHOT: 'true' }
    const cancelled: string[] = []
    const handles = new Map([
      [
        'run-1',
        {
          cancel: async (): Promise<void> => {
            cancelled.push('run-1')
          },
        },
      ],
    ])
    const delivery = createReliableDeliveryQueue()
    delivery.enqueue(started('run-1'))
    delivery.enqueue(exit('run-1'))
    const queues = new Map([['run-1', delivery]])

    const result = await rejectAssignedRun({
      runId: 'run-1',
      handles,
      deliveryQueues: queues,
    })
    expect(cancelled).toEqual(['run-1'])
    expect(result.removed).toBe(true)
    expect(queues.has('run-1')).toBe(false)
    expect(handles.has('run-1')).toBe(false)
    expect(hasPendingDelivery(queues)).toBe(false)
    expect(planAfterRunExit(oneShot, { hasPendingDelivery: hasPendingDelivery(queues) })).toBe('exit')
  })
})

describe('shouldShutdownAfterDelivery', () => {
  it('does not request one-shot exit when shutdown is already in progress', () => {
    const oneShot = { CONDUIT_WORKER_ONE_SHOT: 'true' }
    expect(
      shouldShutdownAfterDelivery({ shuttingDown: true, hasPendingDelivery: false, env: oneShot })
    ).toBe(false)
    expect(
      shouldShutdownAfterDelivery({ shuttingDown: false, hasPendingDelivery: false, env: oneShot })
    ).toBe(true)
    expect(
      shouldShutdownAfterDelivery({ shuttingDown: false, hasPendingDelivery: true, env: oneShot })
    ).toBe(false)
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
