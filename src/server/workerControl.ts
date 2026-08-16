/**
 * Worker control plane — the server side of the /ws/worker secure WebSocket.
 *
 * conduit-worker processes (and EKS/Fargate tasks, later) connect outbound to
 * this endpoint with a Bearer token, advertise their runner capabilities, and
 * heartbeat a lease. The RemoteWorkerFactory dispatches RunSpecs to connected
 * workers here; run events stream back and are fed into each run's
 * WorkerEventSink so the orchestrator's log/broadcast/finalize pipeline is
 * identical to local execution.
 *
 * Isolation: worker sockets live in this module's own registry — never in the
 * browser `clients` broadcast set — so run logs can't leak to workers and
 * workers can't invoke browser RPC channels.
 */
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { RunSpec, WorkerEventSink, WorkerHandle } from '../shared/worker'
import type { ServerToWorkerMessage, WorkerCapabilities } from '../shared/workerControl'
import {
  WORKER_LEASE_MS,
  WORKER_MAX_MESSAGE_BYTES,
  parseWorkerToServerMessage,
} from '../shared/workerControl'
import { reporter } from './observability'

const DEFAULT_ASSIGN_TIMEOUT_MS = 120_000
const DEFAULT_CONNECT_TIMEOUT_MS = 600_000

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** How long a run:assign waits for the worker's run:started before failing. */
export function resolveAssignTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveMs(env.CONDUIT_WORKER_ASSIGN_TIMEOUT_MS, DEFAULT_ASSIGN_TIMEOUT_MS)
}

/** Default wait for a named worker to connect (Job/Task-per-run factories:
 *  pod/task startup + image pull can take minutes). */
export function resolveConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveMs(env.CONDUIT_WORKER_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS)
}

/** Import-time default from process.env — factories that don't pass waitMs. */
export const WORKER_CONNECT_TIMEOUT_MS = resolveConnectTimeoutMs()

/** Optional constructor injection for timeouts and frame limits. */
export interface WorkerControlPlaneOptions {
  assignTimeoutMs?: number
  connectTimeoutMs?: number
  maxMessageBytes?: number
}

interface ConnectedWorker {
  workerId: string
  ws: WebSocket
  capabilities: WorkerCapabilities
  lastHeartbeat: number
  /** Run ids this worker reported in its latest heartbeat/hello. */
  reportedRunIds: Set<string>
}

interface Assignment {
  spec: RunSpec
  sink: WorkerEventSink
  workerId: string
  workspacePath?: string
  started: boolean
  settle: (handle: WorkerHandle) => void
  fail: (err: Error) => void
  timeout: NodeJS.Timeout
}

export class WorkerControlPlane {
  private wss = new WebSocketServer({ noServer: true })
  private workers = new Map<string, ConnectedWorker>()
  private runs = new Map<string, Assignment>()
  /** Named workers that Job/Task-per-run factories are waiting to connect. */
  private waiters = new Map<
    string,
    {
      resolve: (worker: ConnectedWorker) => void
      reject: (err: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  private leaseTimer: NodeJS.Timeout
  private readonly assignTimeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly maxMessageBytes: number
  /** run:started frames that belong to a dropped (timed-out) assignment. */
  private ignoreNextStarted = new Set<string>()

  constructor(options?: WorkerControlPlaneOptions) {
    this.assignTimeoutMs = options?.assignTimeoutMs ?? resolveAssignTimeoutMs()
    this.connectTimeoutMs = options?.connectTimeoutMs ?? resolveConnectTimeoutMs()
    this.maxMessageBytes = options?.maxMessageBytes ?? WORKER_MAX_MESSAGE_BYTES
    this.wss.on('connection', (ws) => this.onConnection(ws))
    this.leaseTimer = setInterval(() => this.checkLeases(), WORKER_LEASE_MS / 3)
    this.leaseTimer.unref()
  }

  /** The shared secret workers must present. Unset = endpoint refuses all upgrades. */
  static token(): string | undefined {
    return process.env.CONDUIT_WORKER_TOKEN?.trim() || undefined
  }

  /** Upgrade entry point for /ws/worker (called from the server's upgrade handler). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const token = WorkerControlPlane.token()
    const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (!token || presented !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req)
    })
  }

  /** Connected worker count (observability + tests). */
  get connectedWorkerCount(): number {
    return this.workers.size
  }

  /**
   * Dispatch a RunSpec to the least-loaded connected worker that supports the
   * runner. Resolves with the run's handle once the worker reports execution
   * is live (run:started); rejects if prep fails on the worker, no suitable
   * worker is connected, or the assignment times out.
   */
  assign(spec: RunSpec, sink: WorkerEventSink): Promise<WorkerHandle> {
    const worker = this.pickWorker(spec.runner)
    if (!worker) {
      return Promise.reject(
        new Error(
          `No connected worker supports runner "${spec.runner}" ` +
            `(${this.workers.size} worker(s) connected).`
        )
      )
    }

    return this.assignToConnected(worker, spec, sink)
  }

  /**
   * Dispatch a RunSpec to a specific named worker, waiting for it to connect
   * if necessary. Used by Job/Task-per-run factories (EKS/Fargate), which
   * create infrastructure that then dials in with a known workerId.
   */
  assignTo(
    workerId: string,
    spec: RunSpec,
    sink: WorkerEventSink,
    waitMs?: number
  ): Promise<WorkerHandle> {
    const timeoutMs = waitMs ?? this.connectTimeoutMs
    const existing = this.workers.get(workerId)
    if (existing) return this.assignToConnected(existing, spec, sink)
    return new Promise<WorkerHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(workerId)
        reject(new Error(`Worker ${workerId} did not connect within ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiters.set(workerId, {
        resolve: (worker) => {
          clearTimeout(timer)
          this.waiters.delete(workerId)
          resolve(this.assignToConnected(worker, spec, sink))
        },
        reject: (err) => {
          clearTimeout(timer)
          this.waiters.delete(workerId)
          reject(err)
        },
        timer,
      })
    })
  }

  private assignToConnected(
    worker: ConnectedWorker,
    spec: RunSpec,
    sink: WorkerEventSink
  ): Promise<WorkerHandle> {
    const runId = spec.runId
    return new Promise<WorkerHandle>((resolve, reject) => {
      const assignment: Assignment = {
        spec,
        sink,
        workerId: worker.workerId,
        started: false,
        settle: (handle) => {
          assignment.started = true
          clearTimeout(assignment.timeout)
          resolve(handle)
        },
        fail: (err) => {
          clearTimeout(assignment.timeout)
          this.runs.delete(runId)
          reject(err)
        },
        timeout: setTimeout(() => {
          const a = this.runs.get(runId)
          if (a && !a.started) {
            this.ignoreNextStarted.add(runId)
            this.sendToWorker(a.workerId, { type: 'run:cancel', runId })
            a.fail(
              new Error(
                `Worker ${a.workerId} did not start run ${runId} within ${this.assignTimeoutMs}ms`
              )
            )
          }
        }, this.assignTimeoutMs),
      }
      this.runs.set(runId, assignment)
      this.sendToWorker(worker.workerId, { type: 'run:assign', spec })
    })
  }

  /** Least-loaded connected worker advertising the runner CLI. */
  private pickWorker(runner: string): ConnectedWorker | undefined {
    let best: ConnectedWorker | undefined
    let bestLoad = Infinity
    for (const w of this.workers.values()) {
      if (!w.capabilities.runners.includes(runner as WorkerCapabilities['runners'][number])) continue
      let load = 0
      for (const a of this.runs.values()) if (a.workerId === w.workerId) load++
      if (load < bestLoad) {
        best = w
        bestLoad = load
      }
    }
    return best
  }

  private sendToWorker(workerId: string, msg: ServerToWorkerMessage): void {
    const w = this.workers.get(workerId)
    if (w && w.ws.readyState === WebSocket.OPEN) {
      w.ws.send(JSON.stringify(msg))
    }
  }

  private buildHandle(runId: string, assignment: Assignment): WorkerHandle {
    return {
      runId,
      workspacePath: assignment.workspacePath,
      // Remote workspaces live on the worker's disk — the worker sweeps them;
      // the server's cleanup must not try to delete paths it can't see.
      worktreeClonePath: undefined,
      ephemeral: false,
      workerId: assignment.workerId,
      cancel: async () => {
        this.sendToWorker(assignment.workerId, { type: 'run:cancel', runId })
      },
    }
  }

  private onConnection(ws: WebSocket): void {
    let workerId: string | undefined
    let closed = false
    let protocolClose = false

    const rejectSocket = (code: number, reason: string): void => {
      if (closed) return
      closed = true
      protocolClose = true
      try {
        ws.close(code, reason)
      } catch {
        // already closing
      }
    }

    ws.on('message', (data) => {
      if (closed) return
      if (rawMessageBytes(data) > this.maxMessageBytes) {
        rejectSocket(1009, 'message too large')
        return
      }
      const parsed = parseWorkerToServerMessage(data.toString())
      if (!parsed.ok) {
        rejectSocket(parsed.error === 'oversized-batch' ? 1009 : 1008, parsed.error)
        return
      }
      const msg = parsed.message
      if (!workerId && msg.type !== 'worker:hello') {
        rejectSocket(1008, 'hello required')
        return
      }

      switch (msg.type) {
        case 'worker:hello': {
          if (workerId && msg.workerId !== workerId) {
            console.warn(
              `[worker-control] Ignoring identity change on socket ${workerId} → ${msg.workerId}`
            )
            break
          }
          if (workerId && msg.workerId === workerId) {
            const current = this.workers.get(workerId)
            if (current && current.ws === ws) {
              current.capabilities = msg.capabilities
              current.lastHeartbeat = Date.now()
              current.reportedRunIds = new Set(msg.activeRunIds)
            }
            break
          }
          workerId = msg.workerId
          const existing = this.workers.get(workerId)
          if (existing && existing.ws !== ws) {
            existing.ws.close(4000, 'replaced by new connection')
          }
          this.workers.set(workerId, {
            workerId,
            ws,
            capabilities: msg.capabilities,
            lastHeartbeat: Date.now(),
            reportedRunIds: new Set(msg.activeRunIds),
          })
          console.log(
            `[worker-control] Worker connected: ${workerId} ` +
              `(runners: ${msg.capabilities.runners.join(', ') || 'none'}, v${msg.capabilities.version})`
          )
          // A Job/Task-per-run factory may be waiting for this exact worker.
          this.waiters.get(workerId)?.resolve(this.workers.get(workerId)!)
          break
        }
        case 'worker:heartbeat': {
          const w = workerId ? this.workers.get(workerId) : undefined
          if (w && w.ws === ws) {
            w.lastHeartbeat = Date.now()
            w.reportedRunIds = new Set(msg.activeRunIds)
          }
          break
        }
        case 'run:started': {
          if (this.ignoreNextStarted.delete(msg.runId)) break
          const a = this.ownedAssignment(msg.runId, workerId)
          if (a && !a.started) {
            a.workspacePath = msg.workspacePath
            a.settle(this.buildHandle(msg.runId, a))
          }
          break
        }
        case 'run:event': {
          const a = this.ownedAssignment(msg.runId, workerId)
          if (a) {
            for (const ev of msg.events) a.sink.onEvent(ev)
          }
          break
        }
        case 'run:exit': {
          const a = this.ownedAssignment(msg.runId, workerId)
          if (!a) break
          if (!a.started) {
            // Execution never went live (prep failed on the worker) — let the
            // factory's startRun reject so the orchestrator's start-failure
            // path owns the run record; don't also fire the sink.
            a.fail(
              new Error(
                `Worker ${a.workerId} failed to start run ${msg.runId} (status: ${msg.status})`
              )
            )
          } else {
            clearTimeout(a.timeout)
            this.runs.delete(msg.runId)
            a.sink.onExit(msg.status, msg.exitCode)
          }
          break
        }
      }
    })

    ws.on('close', () => {
      closed = true
      if (!workerId) return
      const w = this.workers.get(workerId)
      if (w?.ws === ws) {
        this.workers.delete(workerId)
        if (protocolClose) {
          this.failRunsOfWorker(workerId, 'protocol violation', { systemEvent: false })
        } else {
          console.warn(`[worker-control] Worker disconnected: ${workerId}`)
          this.failRunsOfWorker(workerId, 'disconnected')
        }
      }
    })
  }

  /** Assignment exists and belongs to this socket's worker identity. */
  private ownedAssignment(runId: string, socketWorkerId: string | undefined): Assignment | undefined {
    if (!socketWorkerId) return undefined
    const a = this.runs.get(runId)
    if (!a || a.workerId !== socketWorkerId) return undefined
    return a
  }

  /** Lease enforcement: a worker silent for longer than the lease is dead. */
  private checkLeases(): void {
    const now = Date.now()
    for (const w of [...this.workers.values()]) {
      if (now - w.lastHeartbeat > WORKER_LEASE_MS) {
        this.workers.delete(w.workerId)
        try {
          w.ws.close(4001, 'lease expired')
        } catch {
          // already closing
        }
        console.warn(`[worker-control] Worker lease expired: ${w.workerId}`)
        this.failRunsOfWorker(w.workerId, 'lost contact (lease expired)')
      }
    }
  }

  /**
   * Synthesize failures for every run a dead worker was executing so the
   * orchestrator finalizes them (log, broadcast, publish, cleanup) instead of
   * leaving them "running" forever. Pending assignments reject instead.
   */
  private failRunsOfWorker(
    workerId: string,
    reason: string,
    opts: { systemEvent?: boolean } = {}
  ): void {
    const systemEvent = opts.systemEvent !== false
    for (const [runId, a] of [...this.runs.entries()]) {
      if (a.workerId !== workerId) continue
      const err = new Error(`Worker ${workerId} ${reason}`)
      reporter.captureMessage(err.message, 'warning', {
        tags: { component: 'worker-control', workerId, runId },
      })
      if (!a.started) {
        a.fail(err)
      } else {
        clearTimeout(a.timeout)
        this.runs.delete(runId)
        if (systemEvent) {
          a.sink.onEvent({
            kind: 'raw',
            stream: 'system',
            text: `[Conduit: worker ${workerId} ${reason} — failing this run.]`,
          })
        }
        a.sink.onExit('failed', null)
      }
    }
  }

  stop(): void {
    clearInterval(this.leaseTimer)
    for (const waiter of [...this.waiters.values()]) {
      waiter.reject(new Error('Worker control plane is shutting down'))
    }
    this.waiters.clear()
    for (const a of [...this.runs.values()]) {
      if (!a.started) {
        a.fail(new Error('Worker control plane is shutting down'))
      } else {
        clearTimeout(a.timeout)
        this.runs.delete(a.spec.runId)
        a.sink.onEvent({
          kind: 'raw',
          stream: 'system',
          text: `[Conduit: worker ${a.workerId} shutting down — failing this run.]`,
        })
        a.sink.onExit('failed', null)
      }
    }
    for (const w of this.workers.values()) {
      try {
        w.ws.close(1001, 'server shutting down')
      } catch {
        // best-effort
      }
    }
    this.workers.clear()
    this.ignoreNextStarted.clear()
  }
}

function rawMessageBytes(data: Buffer | ArrayBuffer | Buffer[] | string): number {
  if (typeof data === 'string') return Buffer.byteLength(data)
  if (Buffer.isBuffer(data)) return data.length
  if (Array.isArray(data)) return data.reduce((n, chunk) => n + chunk.length, 0)
  return data.byteLength
}

let controlPlane: WorkerControlPlane | null = null

/** Process-wide control plane, created lazily so importing modules at startup
 *  doesn't open the endpoint before the upgrade handler is wired. */
export function getWorkerControlPlane(): WorkerControlPlane {
  if (!controlPlane) controlPlane = new WorkerControlPlane()
  return controlPlane
}
