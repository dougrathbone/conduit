/**
 * In-process end-to-end tests for the worker control plane: a real HTTP
 * server, real WebSocket clients standing in for conduit-worker, exercising
 * auth, assign/assignTo, event streaming, cancellation, and exit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import { AddressInfo } from 'net'
import WebSocket from 'ws'
import { WorkerControlPlane } from './workerControl'
import type { RunSpec } from '../shared/worker'
import type { ServerToWorkerMessage } from '../shared/workerControl'

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
  close: () => Promise<void>
}

function startServer(): Promise<TestCtx> {
  process.env.CONDUIT_WORKER_TOKEN = TOKEN
  const controlPlane = new WorkerControlPlane()
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => controlPlane.handleUpgrade(req, socket, head))
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        server,
        controlPlane,
        url: `ws://127.0.0.1:${port}/ws/worker`,
        close: () =>
          new Promise<void>((res) => {
            controlPlane.stop()
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
    expect(assignMsg).toEqual({ type: 'run:assign', spec: SPEC })

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
    expect(await worker.next()).toEqual({ type: 'run:assign', spec: SPEC })
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
    expect(await worker.next()).toEqual({ type: 'run:assign', spec: SPEC })
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
})
