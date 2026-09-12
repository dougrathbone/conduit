/**
 * conduit-worker — the standalone execution agent.
 *
 * Connects outbound to the Conduit server's secure WebSocket control plane
 * (/ws/worker) with a Bearer token, advertises which runner CLIs it has, and
 * executes RunSpecs via the same LocalWorkerFactory the server uses for
 * in-process runs. Run events stream back over the socket; the worker sweeps
 * its own workspaces and per-run configs when runs end.
 *
 * Required env:
 *   CONDUIT_SERVER_URL    ws(s)://<conduit-host>/ws/worker
 *   CONDUIT_WORKER_TOKEN  shared secret matching the server's token
 * Optional env:
 *   CONDUIT_WORKER_ID         stable identity (default: <hostname>-<pid>)
 *   CONDUIT_WORKER_ONE_SHOT   true/1/yes — accept one assigned run, then exit
 *                             (Fargate). Unset/false keeps pooled reconnect.
 *
 * Workers are trusted execution environments: RunSpecs carry resolved secrets
 * (API keys, git tokens, MCP OAuth headers), so the channel must be TLS
 * (wss://) outside localhost and the host must be dedicated to Conduit runs.
 */
import '../server/observability/instrument'
import { log, flushLogging } from '../server/logging'
import { WebSocket } from 'ws'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import type { RunnerType } from '../shared/types'
import type { RunSpec, WorkerEventSink, WorkerHandle } from '../shared/worker'
import type {
  ServerToWorkerMessage,
  WorkerCapabilities,
  WorkerToServerMessage,
} from '../shared/workerControl'
import {
  resolveWorkerReconnectTimeoutMs,
  WORKER_HEARTBEAT_INTERVAL_MS,
} from '../shared/workerControl'
import { LocalWorkerFactory } from '../server/workers/localWorker'
import { deleteMcpConfig } from '../main/utils/mcpConfigFile'
import { deleteClaudeConfig } from '../main/utils/claudeConfig'
import { deleteWorkspace } from '../main/execution/workspace'
import { removeWorktree } from '../server/gitOps'
import { isWorkerOneShot } from './oneShot'
import { createEventFlushQueue } from './eventFlush'
import { createReliableDeliveryQueue, type ReliableDeliveryQueue } from './reliableDelivery'
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
import { createIdempotentShutdown, sendWsJson } from './wsSend'

const SERVER_URL = process.env.CONDUIT_SERVER_URL?.trim()
const TOKEN = process.env.CONDUIT_WORKER_TOKEN?.trim()
const WORKER_ID = process.env.CONDUIT_WORKER_ID?.trim() || `${os.hostname()}-${process.pid}`
/** Bumped when the control-plane protocol changes; reported in worker:hello.
 *  2 = sequenced/resumable delivery (run:ack, run:resume, run:reject). */
const PROTOCOL_VERSION = '2'

if (!SERVER_URL || !TOKEN) {
  log.error('Missing worker configuration', {
    hasServerUrl: Boolean(SERVER_URL),
    hasToken: Boolean(TOKEN),
  })
  process.exit(1)
}

/** Delay before removing a finished run's workspace, so executables it spawned
 *  can exit and release file handles first (mirrors the server's cleanup). */
const WORKSPACE_CLEANUP_DELAY_MS = 30_000

/** Grace for the startup sweep of leftover workspaces from a crashed worker. */
const STALE_WORKSPACE_GRACE_MS = 6 * 60 * 60 * 1000 // 6h

const factory = new LocalWorkerFactory()
const handles = new Map<string, WorkerHandle>()
const deliveryQueues = new Map<string, ReliableDeliveryQueue>()
const rejectedRuns = createRejectedRunLedger()
const policy = createReconnectPolicy({
  timeoutMs: resolveWorkerReconnectTimeoutMs(),
  // The window must also expire while connected: a server that never resumes
  // or rejects a reported run would otherwise leave the worker waiting forever.
  onExpired: () => {
    void expireRecovery()
  },
})

let ws: WebSocket | null = null
let heartbeat: NodeJS.Timeout | null = null
let shuttingDown = false
/** Set on the first run:assign. One-shot workers still reconnect until terminal
 *  delivery is acknowledged; they do not exit on a dropped control plane. */
let acceptedAssignment = false

function send(msg: WorkerToServerMessage, timeoutMs?: number): Promise<void> {
  return sendWsJson(ws, msg, timeoutMs)
}

function commandExists(binary: string): boolean {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

function detectCapabilities(): WorkerCapabilities {
  const runners: RunnerType[] = []
  if (commandExists('claude')) runners.push('claude')
  if (commandExists('amp')) runners.push('amp')
  if (commandExists('cursor-agent')) runners.push('cursor')
  return { runners, version: PROTOCOL_VERSION }
}

/**
 * Post-run cleanup of everything this worker created for the run — the
 * counterpart of the server's cleanupRun, for worker-local artifacts. MCP and
 * Claude configs carry tokens → removed immediately; the workspace is removed
 * after a short delay.
 */
function cleanupAfterRun(runId: string, handle: WorkerHandle): void {
  deleteMcpConfig(runId)
  deleteClaudeConfig(runId)
  const workspacePath = handle.workspacePath
  if (!workspacePath || (!handle.worktreeClonePath && !handle.ephemeral)) return
  setTimeout(() => {
    void (async () => {
      try {
        if (handle.worktreeClonePath) await removeWorktree(handle.worktreeClonePath, workspacePath)
        else deleteWorkspace(workspacePath)
      } catch (err) {
        log.error('Workspace cleanup failed', { runId, err })
      }
    })()
  }, WORKSPACE_CLEANUP_DELAY_MS)
}

/** Reap workspaces/configs a previous incarnation of this worker left behind
 *  (crash, kill -9). Runs older than the grace window and not currently active
 *  are safe to delete. */
function sweepStaleArtifacts(): void {
  const cutoff = Date.now() - STALE_WORKSPACE_GRACE_MS
  const activeRunIds = new Set(handles.keys())
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // conduit-<runId|agentId>-XXXX (workspaces), conduit-mcp-<runId>.json,
    // conduit-claude-<runId> (config dirs)
    const match = entry.name.match(/^conduit-(?:mcp-|claude-)?([0-9a-f-]{36})/)
    if (!match) continue
    if (activeRunIds.has(match[1])) continue
    const full = path.join(os.tmpdir(), entry.name)
    try {
      if (fs.statSync(full).mtimeMs > cutoff) continue
      fs.rmSync(full, { recursive: true, force: true })
      log.info('Swept stale artifact', { name: entry.name })
    } catch {
      // best-effort
    }
  }
}

function maybeExitAfterDelivery(deliveryExpired = false): void {
  if (
    !shouldShutdownAfterDelivery({
      shuttingDown,
      hasPendingDelivery: hasPendingDelivery(deliveryQueues),
      env: process.env,
    })
  ) {
    return
  }
  void shutdown(shutdownExitCode({ deliveryExpired }))
}

async function drainOrDefer(delivery: ReliableDeliveryQueue): Promise<void> {
  try {
    await delivery.drain((frame) => send(frame))
  } catch {
    // Socket write failed; run:resume after reconnect replays unwritten frames.
  }
}

async function execute(spec: RunSpec, assignId?: string): Promise<void> {
  const runId = spec.runId
  log.info('Starting run', { runId, runner: spec.runner, workspaceKind: spec.workspace.kind })

  const delivery = createReliableDeliveryQueue()
  deliveryQueues.set(runId, delivery)

  const events = createEventFlushQueue({
    runId,
    send: (frame) => send(frame),
    delivery,
  })

  const sink: WorkerEventSink = {
    onEvent: (ev) => {
      events.push(ev)
    },
    onError: (err) => {
      sink.onEvent({ kind: 'raw', stream: 'system', text: `\n[Error: ${err.message}]\n` })
    },
    onExit: (status, exitCode) => {
      void (async () => {
        if (!deliveryQueues.has(runId)) return
        const handle = handles.get(runId)
        handles.delete(runId)
        await recordLocalExit(events, delivery, { type: 'run:exit', runId, status, exitCode })
        await drainOrDefer(delivery)
        log.info('Run exited', { runId, status, exitCode: exitCode ?? undefined })
        if (handle) cleanupAfterRun(runId, handle)
        maybeExitAfterDelivery()
      })()
    },
  }

  try {
    const handle = await factory.startRun(spec, sink)
    // A run:reject can land while the CLI was still being spawned; installing
    // through the ledger cancels such a handle instead of leaking the process.
    const installed = await installUnlessRejected(rejectedRuns, runId, handle, handles)
    if (!installed) {
      deliveryQueues.delete(runId)
      cleanupAfterRun(runId, handle)
      maybeExitAfterDelivery(true)
      return
    }
    delivery.enqueue({ type: 'run:started', runId, workspacePath: handle.workspacePath, assignId })
    await drainOrDefer(delivery)
  } catch (err) {
    // Prep failed (clone, config write, spawn args) — the factory rolled back
    // its partial work; tell the server so the run is marked failed.
    log.error('Failed to start run', { runId, err })
    await recordLocalExit(events, delivery, {
      type: 'run:exit',
      runId,
      status: 'failed',
      exitCode: null,
    })
    await drainOrDefer(delivery)
    maybeExitAfterDelivery()
  }
}

function applyAck(runId: string, sequence: number): void {
  const delivery = deliveryQueues.get(runId)
  if (!delivery) return
  const kind = applyDeliveryAck(delivery, sequence)
  if (kind === 'terminal') {
    policy.noteHandled(runId)
    deliveryQueues.delete(runId)
    maybeExitAfterDelivery()
  }
}

function applyResume(runId: string, sequence: number): void {
  const delivery = deliveryQueues.get(runId)
  if (!delivery) return
  void replayFromCursor(delivery, sequence, (frame) => send(frame))
    .then((accepted) => {
      // Only an accepted cursor means the server adopted this run's delivery,
      // so only then may the outage deadline stop counting.
      if (accepted) policy.noteHandled(runId)
    })
    .catch(() => {
      // Disconnect during replay; the next resume retries from the durable cursor.
    })
}

async function applyReject(runId: string, reason: string): Promise<void> {
  log.warn('Run rejected by server', { runId, reason })
  rejectedRuns.reject(runId)
  const result = await rejectAssignedRun({ runId, handles, deliveryQueues })
  if (result.handle) {
    rejectedRuns.clear(runId)
    cleanupAfterRun(runId, result.handle)
  }
  policy.noteHandled(runId)
  // A rejected run never delivered: a one-shot worker must exit visibly
  // non-zero so the orchestrator does not read it as a clean run.
  maybeExitAfterDelivery(true)
}

async function expireRecovery(): Promise<void> {
  shuttingDown = true
  policy.cancel()
  const pending = pendingRunIds(handles.keys(), deliveryQueues)
  log.error('Delivery recovery expired — giving up', { pendingRunIds: pending })
  const result = await expireDeliveryRecovery({ handles, pendingRunIds: pending })
  handles.clear()
  try {
    ws?.close(1001, 'delivery recovery expired')
  } catch {
    // best-effort
  }
  await shutdown(result.exitCode)
}

function connect(): void {
  if (shuttingDown) return
  const sock = new WebSocket(SERVER_URL!, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  ws = sock

  sock.on('open', () => {
    policy.noteOpen()
    const caps = detectCapabilities()
    const activeRunIds = [...handles.keys()]
    const pending = pendingRunIds(activeRunIds, deliveryQueues)
    log.info('Connected to control plane', {
      serverUrl: SERVER_URL,
      workerId: WORKER_ID,
      runners: caps.runners,
    })
    void send({
      type: 'worker:hello',
      workerId: WORKER_ID,
      capabilities: caps,
      activeRunIds,
      pendingRunIds: pending,
    }).catch((err) => {
      log.error('worker:hello failed', { err })
    })
    if (pending.length === 0) policy.resetBackoff()
    heartbeat = setInterval(() => {
      void send({
        type: 'worker:heartbeat',
        workerId: WORKER_ID,
        activeRunIds: [...handles.keys()],
      }).catch(() => {
        // Heartbeat write failures are retried on the next interval or reconnect.
      })
    }, WORKER_HEARTBEAT_INTERVAL_MS)
  })

  sock.on('message', (data) => {
    let msg: ServerToWorkerMessage
    try {
      msg = JSON.parse(data.toString()) as ServerToWorkerMessage
    } catch {
      return
    }
    if (msg.type === 'run:assign') {
      if (isWorkerOneShot() && acceptedAssignment) {
        log.warn('Ignoring additional run:assign — one-shot already assigned', { runId: msg.spec.runId })
        return
      }
      acceptedAssignment = true
      if (typeof msg.reconnectTimeoutMs === 'number') {
        policy.setTimeoutMs(msg.reconnectTimeoutMs)
      }
      void execute(msg.spec, msg.assignId)
    } else if (msg.type === 'run:cancel') {
      log.info('Cancel requested', { runId: msg.runId })
      void handles.get(msg.runId)?.cancel()
    } else if (msg.type === 'run:ack') {
      applyAck(msg.runId, msg.sequence)
    } else if (msg.type === 'run:resume') {
      applyResume(msg.runId, msg.sequence)
    } else if (msg.type === 'run:reject') {
      void applyReject(msg.runId, msg.reason)
    }
  })

  sock.on('close', (code, reason) => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    ws = null
    if (shuttingDown) return
    const recovering = handles.size > 0 || deliveryQueues.size > 0
    if (recovering) {
      holdAllSends(deliveryQueues)
      policy.noteDisconnect(pendingRunIds(handles.keys(), deliveryQueues))
    }
    log.warn('Disconnected from control plane — reconnecting', { code, reason: String(reason) })
    policy.scheduleReconnect(connect, () => {
      void expireRecovery()
    })
  })

  sock.on('error', (err) => {
    log.error('WebSocket error', { err })
  })
}

const shutdown = createIdempotentShutdown(async (exitCode) => {
  shuttingDown = true
  policy.cancel()
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  log.info('Shutting down — cancelling active runs', { activeRuns: handles.size })
  await factory.shutdown()
  handles.clear()
  try {
    ws?.close(1001, 'worker shutting down')
  } catch {
    // best-effort
  }
  await flushLogging(2000).catch(() => {})
  // Give the close frame a moment to flush before exiting.
  await new Promise<void>((resolve) => setTimeout(resolve, 500))
  process.exit(exitCode)
})

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

sweepStaleArtifacts()
connect()
