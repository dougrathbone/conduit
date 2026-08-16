/**
 * In-process end-to-end tests for the worker control plane: a real HTTP
 * server, real WebSocket clients standing in for conduit-worker, exercising
 * auth, assign/assignTo, event streaming, cancellation, and exit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import { AddressInfo } from 'net'
import WebSocket from 'ws'
import {
  WorkerControlPlane,
  resolveAssignTimeoutMs,
  resolveConnectTimeoutMs,
  type WorkerControlPlaneOptions,
} from './workerControl'
import type { RunSpec } from '../shared/worker'
import type { ServerToWorkerMessage } from '../shared/workerControl'
import { WORKER_MAX_EVENT_BATCH, WORKER_MAX_MESSAGE_BYTES } from '../shared/workerControl'

const TOKEN = 'test-worker-token'

const SPEC: RunSpec = {
  runId: 'run-1',
  agentId: 'agent-1',
  runner: 'claude',
  prompt: 'hello',
  env: {},
  workspace: { kind: 'ephemeral' },
}

interface TestCtx {
  server: http.Server
  controlPlane: WorkerControlPlane
  url: string
  sockets: WebSocket[]
  close: () => Promise<void>
}

function startServer(options?: WorkerControlPlaneOptions): Promise<TestCtx> {
  process.env.CONDUIT_WORKER_TOKEN = TOKEN
  const controlPlane = new WorkerControlPlane(options)
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => controlPlane.handleUpgrade(req, socket, head))
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      const sockets: WebSocket[] = []
      resolve({
        server,
        controlPlane,
        url: `ws://127.0.0.1:${port}/ws/worker`,
        sockets,
        close: () =>
          new Promise<void>((res) => {
            for (const ws of sockets) {
              try {
                ws.terminate()
              } catch {
                // already closed
              }
            }
            sockets.length = 0
            controlPlane.stop()
            server.closeAllConnections()
            server.close(() => res())
          }),
      })
    })
  })
}

function connectWorker(
  ctx: TestCtx,
  opts: { token?: string; workerId?: string; activeRunIds?: string[] } = {}
): Promise<{ ws: WebSocket; next: () => Promise<ServerToWorkerMessage> }> {
  const before = ctx.controlPlane.connectedWorkerCount
  const ws = new WebSocket(ctx.url, { headers: { authorization: `Bearer ${opts.token ?? TOKEN}` } })
  ctx.sockets.push(ws)
  const queue: ServerToWorkerMessage[] = []
  const pending: ((m: ServerToWorkerMessage) => void)[] = []
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerToWorkerMessage
    if (pending.length > 0) pending.shift()!(msg)
    else queue.push(msg)
  })
  const next = () =>
    new Promise<ServerToWorkerMessage>((resolve) => {
      if (queue.length > 0) resolve(queue.shift()!)
      else pending.push(resolve)
    })
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'worker:hello',
          workerId: opts.workerId ?? 'w1',
          capabilities: { runners: ['claude'], version: 'test' },
          activeRunIds: opts.activeRunIds ?? [],
        })
      )
      // Resolve only once the server has registered the worker, so tests can
      // assign runs immediately without racing hello processing.
      const poll = setInterval(() => {
        if (ctx.controlPlane.connectedWorkerCount > before) {
          clearInterval(poll)
          resolve({ ws, next })
        }
      }, 5)
      setTimeout(() => {
        clearInterval(poll)
        reject(new Error('worker registration timed out'))
      }, 5000).unref()
    })
    ws.on('error', reject)
  })
}

function connectSocket(ctx: TestCtx, opts: { token?: string } = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ctx.url, { headers: { authorization: `Bearer ${opts.token ?? TOKEN}` } })
    ctx.sockets.push(ws)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function expectClose(ws: WebSocket, ms = 200): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket was not closed')), ms)
    if (ws.readyState === WebSocket.CLOSED) {
      clearTimeout(timer)
      resolve({ code: 1006, reason: 'already closed' })
      return
    }
    ws.on('close', (code, reason) => {
      clearTimeout(timer)
      resolve({ code, reason: reason.toString() })
    })
  })
}

function sendJson(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg))
}

describe('WorkerControlPlane', () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await startServer()
  })
  afterEach(async () => {
    await ctx.close()
    delete process.env.CONDUIT_WORKER_TOKEN
  })

  it('rejects upgrade with wrong bearer token', async () => {
    await expect(connectWorker(ctx, { token: 'wrong' })).rejects.toThrow(/401/)
    expect(ctx.controlPlane.connectedWorkerCount).toBe(0)
  })

  it('assigns a run, streams events, and reports exit', async () => {
    const worker = await connectWorker(ctx)
    const events: string[] = []
    let resolveExited!: (v: { status: string; exitCode: number | null }) => void
    const exited = new Promise<{ status: string; exitCode: number | null }>((r) => (resolveExited = r))
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: (ev) => events.push(ev.stream),
      onExit: (status, exitCode) => resolveExited({ status, exitCode }),
    })

    const assignMsg = await worker.next()
    expect(assignMsg).toMatchObject({ type: 'run:assign', spec: SPEC })

    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, workspacePath: '/tmp/x' }))
    worker.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        events: [{ kind: 'raw', stream: 'stdout', text: 'hi' }],
      })
    )
    worker.ws.send(JSON.stringify({ type: 'run:exit', runId: SPEC.runId, status: 'completed', exitCode: 0 }))

    await handlePromise
    const result = await exited
    expect(result).toEqual({ status: 'completed', exitCode: 0 })
    expect(events).toEqual(['stdout'])
  })

  it('assign resolves the handle when the worker reports run:started', async () => {
    const worker = await connectWorker(ctx)
    const sink = { onEvent: () => {}, onExit: () => {} }
    const handlePromise = ctx.controlPlane.assign(SPEC, sink)
    await worker.next() // run:assign
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, workspacePath: '/tmp/x' }))
    const handle = await handlePromise
    expect(handle.runId).toBe(SPEC.runId)
    expect(handle.workspacePath).toBe('/tmp/x')
    await handle.cancel()
    expect(await worker.next()).toEqual({ type: 'run:cancel', runId: SPEC.runId })
  })

  it('rejects assign when no worker supports the runner', async () => {
    await expect(
      ctx.controlPlane.assign({ ...SPEC, runner: 'amp' }, { onEvent: () => {}, onExit: () => {} })
    ).rejects.toThrow(/No connected worker supports runner "amp"/)
  })

  it('assignTo waits for the named worker to connect', async () => {
    const sink = { onEvent: () => {}, onExit: () => {} }
    const handlePromise = ctx.controlPlane.assignTo('late-worker', SPEC, sink)
    // Connect after the waiter is registered.
    const worker = await connectWorker(ctx, { workerId: 'late-worker' })
    expect(await worker.next()).toMatchObject({ type: 'run:assign', spec: SPEC })
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    const handle = await handlePromise
    expect(handle.runId).toBe(SPEC.runId)
  })

  it('assignTo times out when the named worker never connects', async () => {
    await expect(
      ctx.controlPlane.assignTo('ghost', SPEC, { onEvent: () => {}, onExit: () => {} }, 50)
    ).rejects.toThrow(/did not connect within 50ms/)
  })

  it('assignTo dispatches immediately when the worker is already connected', async () => {
    const worker = await connectWorker(ctx, { workerId: 'ready' })
    const handlePromise = ctx.controlPlane.assignTo('ready', SPEC, { onEvent: () => {}, onExit: () => {} })
    expect(await worker.next()).toMatchObject({ type: 'run:assign', spec: SPEC })
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    await handlePromise
  })

  it('synthesizes failure for the run when the worker disconnects', async () => {
    const worker = await connectWorker(ctx)
    const exited = new Promise<{ status: string }>((resolve) => {
      void ctx.controlPlane.assign(SPEC, {
        onEvent: () => {},
        onExit: (status) => resolve({ status }),
      })
    })
    await worker.next()
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    worker.ws.terminate()
    await expect(exited).resolves.toEqual({ status: 'failed' })
  })

  it('rejects messages sent before worker:hello', async () => {
    const ws = await connectSocket(ctx)
    sendJson(ws, { type: 'worker:heartbeat', workerId: 'w1', activeRunIds: [] })
    await expect(expectClose(ws)).resolves.toMatchObject({ code: expect.any(Number) })
    expect(ctx.controlPlane.connectedWorkerCount).toBe(0)
  })

  it('rejects malformed JSON', async () => {
    const ws = await connectSocket(ctx)
    ws.send('{not-json')
    await expect(expectClose(ws)).resolves.toMatchObject({ code: expect.any(Number) })
    expect(ctx.controlPlane.connectedWorkerCount).toBe(0)
  })

  it('rejects oversized frames', async () => {
    const ws = await connectSocket(ctx)
    ws.send('x'.repeat(WORKER_MAX_MESSAGE_BYTES + 1))
    await expect(expectClose(ws)).resolves.toMatchObject({ code: expect.any(Number) })
    expect(ctx.controlPlane.connectedWorkerCount).toBe(0)
  })

  it('rejects run:event batches larger than WORKER_MAX_EVENT_BATCH', async () => {
    const worker = await connectWorker(ctx)
    const events: string[] = []
    const handlePromise = ctx.controlPlane.assign(SPEC, {
      onEvent: (ev) => events.push(ev.stream),
      onExit: () => {},
    })
    await worker.next()
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    await handlePromise
    worker.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        events: Array.from({ length: WORKER_MAX_EVENT_BATCH + 1 }, () => ({
          kind: 'raw',
          stream: 'stdout',
          text: 'x',
        })),
      })
    )
    await expect(expectClose(worker.ws)).resolves.toMatchObject({ code: expect.any(Number) })
    expect(events).toEqual([])
  })

  it('ignores run events whose assignment.workerId does not match the socket workerId', async () => {
    const owner = await connectWorker(ctx, { workerId: 'owner' })
    const stranger = await connectWorker(ctx, { workerId: 'stranger' })
    const events: string[] = []
    let exit: { status: string; exitCode: number | null | undefined } | undefined
    const handlePromise = ctx.controlPlane.assignTo('owner', SPEC, {
      onEvent: (ev) => events.push(ev.stream),
      onExit: (status, exitCode) => {
        exit = { status, exitCode }
      },
    })
    expect(await owner.next()).toMatchObject({ type: 'run:assign', spec: SPEC })
    owner.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    await handlePromise

    stranger.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        events: [{ kind: 'raw', stream: 'stdout', text: 'injected' }],
      })
    )
    stranger.ws.send(
      JSON.stringify({ type: 'run:exit', runId: SPEC.runId, status: 'completed', exitCode: 0 })
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(events).toEqual([])
    expect(exit).toBeUndefined()

    owner.ws.send(JSON.stringify({ type: 'run:exit', runId: SPEC.runId, status: 'completed', exitCode: 0 }))
    await vi.waitFor(() => {
      expect(exit).toEqual({ status: 'completed', exitCode: 0 })
    })
    expect(events).toEqual([])
  })

  it('rejects a second hello that changes worker identity on the same socket', async () => {
    const worker = await connectWorker(ctx, { workerId: 'w1' })
    worker.ws.send(
      JSON.stringify({
        type: 'worker:hello',
        workerId: 'w2',
        capabilities: { runners: ['claude'], version: 'test' },
        activeRunIds: [],
      })
    )
    await new Promise((r) => setTimeout(r, 50))
    // Keep the live w1 session — do not close-and-leak a stale w1 entry.
    expect(worker.ws.readyState).toBe(WebSocket.OPEN)
    expect(ctx.controlPlane.connectedWorkerCount).toBe(1)
    await expect(
      ctx.controlPlane.assignTo('w2', { ...SPEC, runId: 'run-w2' }, { onEvent: () => {}, onExit: () => {} }, 30)
    ).rejects.toThrow(/did not connect/)

    const handlePromise = ctx.controlPlane.assignTo('w1', SPEC, { onEvent: () => {}, onExit: () => {} })
    expect(await worker.next()).toMatchObject({ type: 'run:assign', spec: SPEC })
    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId }))
    await handlePromise
  })

  it('closes the previous socket when a duplicate identity connects', async () => {
    const first = await connectWorker(ctx, { workerId: 'w1' })
    const firstClosed = expectClose(first.ws, 500)
    const second = await connectSocket(ctx)
    sendJson(second, {
      type: 'worker:hello',
      workerId: 'w1',
      capabilities: { runners: ['claude'], version: 'test' },
      activeRunIds: [],
    })
    await firstClosed
    expect(first.ws.readyState).toBe(WebSocket.CLOSED)
    expect(second.readyState).toBe(WebSocket.OPEN)
    expect(ctx.controlPlane.connectedWorkerCount).toBe(1)
  })

  it('does not let a duplicate-identity socket inherit or inject into a live assignment', async () => {
    const owner = await connectWorker(ctx, { workerId: 'fargate-run-1' })
    const events: string[] = []
    let exit: { status: string; exitCode: number | null | undefined } | undefined
    const handlePromise = ctx.controlPlane.assignTo('fargate-run-1', SPEC, {
      onEvent: (ev) => events.push(ev.text ?? ev.stream),
      onExit: (status, exitCode) => {
        exit = { status, exitCode }
      },
    })
    expect(await owner.next()).toMatchObject({ type: 'run:assign', spec: SPEC })
    owner.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, workspacePath: '/tmp/owner' }))
    const handle = await handlePromise
    expect(handle.workspacePath).toBe('/tmp/owner')

    const impostor = await connectSocket(ctx)
    const impostorClosed = expectClose(impostor, 500)
    sendJson(impostor, {
      type: 'worker:hello',
      workerId: 'fargate-run-1',
      capabilities: { runners: ['claude'], version: 'test' },
      activeRunIds: [],
    })
    sendJson(impostor, {
      type: 'run:event',
      runId: SPEC.runId,
      events: [{ kind: 'raw', stream: 'stdout', text: 'injected' }],
    })
    sendJson(impostor, { type: 'run:exit', runId: SPEC.runId, status: 'completed', exitCode: 0 })

    await impostorClosed
    expect(owner.ws.readyState).toBe(WebSocket.OPEN)
    expect(ctx.controlPlane.connectedWorkerCount).toBe(1)
    expect(events).toEqual([])
    expect(exit).toBeUndefined()

    owner.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: SPEC.runId,
        events: [{ kind: 'raw', stream: 'stdout', text: 'from-owner' }],
      })
    )
    owner.ws.send(JSON.stringify({ type: 'run:exit', runId: SPEC.runId, status: 'completed', exitCode: 0 }))
    await vi.waitFor(() => {
      expect(exit).toEqual({ status: 'completed', exitCode: 0 })
    })
    expect(events).toEqual(['from-owner'])
  })

  it('does not deliver events from one run onto another run\'s sink', async () => {
    const a = await connectWorker(ctx, { workerId: 'wa' })
    const b = await connectWorker(ctx, { workerId: 'wb' })
    const specA = SPEC
    const specB = { ...SPEC, runId: 'run-2', agentId: 'agent-2' }
    const eventsA: string[] = []
    const eventsB: string[] = []
    let exitA: string | undefined
    let exitB: string | undefined
    const handleA = ctx.controlPlane.assignTo('wa', specA, {
      onEvent: (ev) => eventsA.push(ev.text ?? ev.stream),
      onExit: (status) => {
        exitA = status
      },
    })
    const handleB = ctx.controlPlane.assignTo('wb', specB, {
      onEvent: (ev) => eventsB.push(ev.text ?? ev.stream),
      onExit: (status) => {
        exitB = status
      },
    })
    expect(await a.next()).toMatchObject({ type: 'run:assign', spec: specA })
    expect(await b.next()).toMatchObject({ type: 'run:assign', spec: specB })
    a.ws.send(JSON.stringify({ type: 'run:started', runId: specA.runId }))
    b.ws.send(JSON.stringify({ type: 'run:started', runId: specB.runId }))
    await Promise.all([handleA, handleB])

    a.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: specB.runId,
        events: [{ kind: 'raw', stream: 'stdout', text: 'cross' }],
      })
    )
    a.ws.send(JSON.stringify({ type: 'run:exit', runId: specB.runId, status: 'failed', exitCode: 1 }))
    b.ws.send(
      JSON.stringify({
        type: 'run:event',
        runId: specB.runId,
        events: [{ kind: 'raw', stream: 'stdout', text: 'ok-b' }],
      })
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(eventsA).toEqual([])
    expect(eventsB).toEqual(['ok-b'])
    expect(exitA).toBeUndefined()
    expect(exitB).toBeUndefined()

    b.ws.send(JSON.stringify({ type: 'run:exit', runId: specB.runId, status: 'completed', exitCode: 0 }))
    await vi.waitFor(() => {
      expect(exitB).toBe('completed')
    })
    expect(exitA).toBeUndefined()
  })

  it('uses constructor assignTimeoutMs and drops the assignment so a late run:started is ignored', async () => {
    await ctx.close()
    ctx = await startServer({ assignTimeoutMs: 50 })
    const worker = await connectWorker(ctx)
    const handlePromise = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    await worker.next()
    await expect(handlePromise).rejects.toThrow(/did not start run/)
    expect(await worker.next()).toEqual({ type: 'run:cancel', runId: SPEC.runId })

    worker.ws.send(JSON.stringify({ type: 'run:started', runId: SPEC.runId, workspacePath: '/tmp/late' }))
    // Let the late frame land while no assignment exists (a no-op). A retry's
    // run:started must not be consumed by the timed-out generation's suppressor.
    await new Promise((r) => setTimeout(r, 20))
    const retry = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    const retryAssign = await worker.next()
    expect(retryAssign).toMatchObject({ type: 'run:assign', spec: SPEC })
    const retryId = retryAssign.type === 'run:assign' ? retryAssign.assignId : undefined
    worker.ws.send(
      JSON.stringify({
        type: 'run:started',
        runId: SPEC.runId,
        workspacePath: '/tmp/ok',
        assignId: retryId,
      })
    )
    const handle = await retry
    expect(handle.workspacePath).toBe('/tmp/ok')
  }, 400)

  it('does not consume a retry run:started after a timed-out assignment', async () => {
    await ctx.close()
    ctx = await startServer({ assignTimeoutMs: 50 })
    const worker = await connectWorker(ctx)
    const first = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    await worker.next()
    await expect(first).rejects.toThrow(/did not start run/)
    expect(await worker.next()).toEqual({ type: 'run:cancel', runId: SPEC.runId })

    const retry = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    const retryAssign = await worker.next()
    expect(retryAssign).toMatchObject({ type: 'run:assign', spec: SPEC })
    const retryId = retryAssign.type === 'run:assign' ? retryAssign.assignId : undefined
    worker.ws.send(
      JSON.stringify({
        type: 'run:started',
        runId: SPEC.runId,
        workspacePath: '/tmp/retry',
        assignId: retryId,
      })
    )
    const handle = await retry
    expect(handle.workspacePath).toBe('/tmp/retry')
  }, 400)

  it('does not settle a retry from a late started of the timed-out assignment', async () => {
    await ctx.close()
    ctx = await startServer({ assignTimeoutMs: 50 })
    const worker = await connectWorker(ctx)
    const first = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    const firstAssign = await worker.next()
    expect(firstAssign).toMatchObject({ type: 'run:assign', spec: SPEC })
    const staleId = firstAssign.type === 'run:assign' ? firstAssign.assignId : undefined
    await expect(first).rejects.toThrow(/did not start run/)
    expect(await worker.next()).toEqual({ type: 'run:cancel', runId: SPEC.runId })

    const retry = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    const retryAssign = await worker.next()
    expect(retryAssign).toMatchObject({ type: 'run:assign', spec: SPEC })
    const freshId = retryAssign.type === 'run:assign' ? retryAssign.assignId : undefined
    expect(freshId).toBeTruthy()
    expect(freshId).not.toBe(staleId)

    worker.ws.send(
      JSON.stringify({
        type: 'run:started',
        runId: SPEC.runId,
        workspacePath: '/tmp/stale',
        assignId: staleId,
      })
    )
    const raced = await Promise.race([
      retry.then((h) => h.workspacePath),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 40)),
    ])
    expect(raced).toBe('pending')

    worker.ws.send(
      JSON.stringify({
        type: 'run:started',
        runId: SPEC.runId,
        workspacePath: '/tmp/fresh',
        assignId: freshId,
      })
    )
    const handle = await retry
    expect(handle.workspacePath).toBe('/tmp/fresh')
  }, 400)

  it('rejects pending assignTo waiters when the control plane stops', async () => {
    const pending = ctx.controlPlane.assignTo('ghost', SPEC, { onEvent: () => {}, onExit: () => {} }, 2_000)
    ctx.controlPlane.stop()
    await expect(pending).rejects.toThrow(/shutting down|stopped/)
  }, 400)

  it('cancelAssignTo rejects the waiter so a late hello does not receive run:assign', async () => {
    const pending = ctx.controlPlane.assignTo(
      'fargate-run-1',
      SPEC,
      { onEvent: () => {}, onExit: () => {} },
      2_000
    )
    ctx.controlPlane.cancelAssignTo(
      'fargate-run-1',
      new Error('Fargate task stopped before the worker connected')
    )
    await expect(pending).rejects.toThrow(/stopped before the worker connected/)

    const worker = await connectWorker(ctx, { workerId: 'fargate-run-1' })
    const assigned = Promise.race([
      worker.next().then((msg) => msg.type),
      new Promise<string>((resolve) => setTimeout(() => resolve('none'), 50)),
    ])
    await expect(assigned).resolves.toBe('none')
  }, 400)

  it('fails a pending assignment (not yet started) when the worker disconnects', async () => {
    const worker = await connectWorker(ctx)
    const handlePromise = ctx.controlPlane.assign(SPEC, { onEvent: () => {}, onExit: () => {} })
    await worker.next()
    worker.ws.terminate()
    await expect(handlePromise).rejects.toThrow(/disconnected/)
  })

  it('does not fail another worker\'s run when one worker disconnects', async () => {
    const keep = await connectWorker(ctx, { workerId: 'keep' })
    const drop = await connectWorker(ctx, { workerId: 'drop' })
    const specKeep = SPEC
    const specDrop = { ...SPEC, runId: 'run-drop' }
    let keepStatus: string | undefined
    const keepHandle = ctx.controlPlane.assignTo('keep', specKeep, {
      onEvent: () => {},
      onExit: (status) => {
        keepStatus = status
      },
    })
    const dropExited = new Promise<string>((resolve) => {
      void ctx.controlPlane.assignTo('drop', specDrop, {
        onEvent: () => {},
        onExit: (status) => resolve(status),
      })
    })
    expect(await keep.next()).toMatchObject({ type: 'run:assign', spec: specKeep })
    expect(await drop.next()).toMatchObject({ type: 'run:assign', spec: specDrop })
    keep.ws.send(JSON.stringify({ type: 'run:started', runId: specKeep.runId }))
    drop.ws.send(JSON.stringify({ type: 'run:started', runId: specDrop.runId }))
    await keepHandle
    drop.ws.terminate()
    await expect(dropExited).resolves.toBe('failed')
    await new Promise((r) => setTimeout(r, 50))
    expect(keepStatus).toBeUndefined()
  })
})

describe('worker control timeouts from supplied env', () => {
  it('reads assign and connect timeouts from the supplied env, not import-time globals', () => {
    expect(resolveAssignTimeoutMs({ CONDUIT_WORKER_ASSIGN_TIMEOUT_MS: '1500' })).toBe(1_500)
    expect(resolveConnectTimeoutMs({ CONDUIT_WORKER_CONNECT_TIMEOUT_MS: '2000' })).toBe(2_000)
  })
})

