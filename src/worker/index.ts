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
import { WebSocket } from 'ws'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import type { RunEventInit, RunnerType } from '../shared/types'
import type { RunSpec, WorkerEventSink, WorkerHandle } from '../shared/worker'
import type {
  ServerToWorkerMessage,
  WorkerCapabilities,
  WorkerToServerMessage,
} from '../shared/workerControl'
import { WORKER_HEARTBEAT_INTERVAL_MS } from '../shared/workerControl'
import { LocalWorkerFactory } from '../server/workers/localWorker'
import { deleteMcpConfig } from '../main/utils/mcpConfigFile'
import { deleteClaudeConfig } from '../main/utils/claudeConfig'
import { deleteWorkspace } from '../main/execution/workspace'
import { removeWorktree } from '../server/gitOps'
import { isWorkerOneShot, planAfterDisconnect, planAfterRunExit } from './oneShot'
import { chunkRunEvents } from './eventBatch'
import { createIdempotentShutdown, sendWsJson } from './wsSend'

const SERVER_URL = process.env.CONDUIT_SERVER_URL?.trim()
const TOKEN = process.env.CONDUIT_WORKER_TOKEN?.trim()
const WORKER_ID = process.env.CONDUIT_WORKER_ID?.trim() || `${os.hostname()}-${process.pid}`
/** Bumped when the control-plane protocol changes; reported in worker:hello. */
const PROTOCOL_VERSION = '1'

if (!SERVER_URL || !TOKEN) {
  console.error(
    '[worker] CONDUIT_SERVER_URL (ws(s)://<host>/ws/worker) and CONDUIT_WORKER_TOKEN are required.'
  )
  process.exit(1)
}

/** Delay before removing a finished run's workspace, so executables it spawned
 *  can exit and release file handles first (mirrors the server's cleanup). */
const WORKSPACE_CLEANUP_DELAY_MS = 30_000

/** Grace for the startup sweep of leftover workspaces from a crashed worker. */
const STALE_WORKSPACE_GRACE_MS = 6 * 60 * 60 * 1000 // 6h

const factory = new LocalWorkerFactory()
const handles = new Map<string, WorkerHandle>()

let ws: WebSocket | null = null
let heartbeat: NodeJS.Timeout | null = null
let reconnectDelayMs = 1000
let shuttingDown = false
/** Set on the first run:assign. One-shot workers exit after this run (or if
 *  the socket drops after assignment); pooled workers ignore the flag. */
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
        console.error(`[worker] Workspace cleanup failed for run ${runId}:`, err)
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
      console.log(`[worker] Swept stale artifact: ${entry.name}`)
    } catch {
      // best-effort
    }
  }
}

async function execute(spec: RunSpec): Promise<void> {
  const runId = spec.runId
  console.log(`[worker] Starting run ${runId} (${spec.runner}, workspace: ${spec.workspace.kind})`)

  // Batch events like the server's runner does — chunked to stay under the
  // server's event-count and encoded-frame limits.
  const buffer: RunEventInit[] = []
  let flushScheduled = false
  async function flush(): Promise<void> {
    flushScheduled = false
    if (buffer.length === 0) return
    const events = buffer.splice(0)
    for (const frame of chunkRunEvents(runId, events)) {
      await send(frame)
    }
  }

  const sink: WorkerEventSink = {
    onEvent: (ev) => {
      buffer.push(ev)
      if (!flushScheduled) {
        flushScheduled = true
        setImmediate(() => {
          void flush()
        })
      }
    },
    onError: (err) => {
      sink.onEvent({ kind: 'raw', stream: 'system', text: `\n[Error: ${err.message}]\n` })
    },
    onExit: (status, exitCode) => {
      void (async () => {
        await flush()
        const handle = handles.get(runId)
        handles.delete(runId)
        await send({ type: 'run:exit', runId, status, exitCode })
        console.log(`[worker] Run ${runId} exited: ${status} (code ${exitCode ?? 'n/a'})`)
        if (handle) cleanupAfterRun(runId, handle)
        if (planAfterRunExit() === 'exit') await shutdown()
      })()
    },
  }

  try {
    const handle = await factory.startRun(spec, sink)
    handles.set(runId, handle)
    void send({ type: 'run:started', runId, workspacePath: handle.workspacePath })
  } catch (err) {
    // Prep failed (clone, config write, spawn args) — the factory rolled back
    // its partial work; tell the server so the run is marked failed.
    console.error(`[worker] Failed to start run ${runId}:`, err)
    await flush()
    await send({
      type: 'run:exit',
      runId,
      status: 'failed',
      exitCode: null,
    })
    if (planAfterRunExit() === 'exit') await shutdown()
  }
}

function connect(): void {
  if (shuttingDown) return
  const sock = new WebSocket(SERVER_URL!, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  ws = sock

  sock.on('open', () => {
    reconnectDelayMs = 1000
    const caps = detectCapabilities()
    console.log(`[worker] Connected to ${SERVER_URL} as ${WORKER_ID} (runners: ${caps.runners.join(', ') || 'none'})`)
    void send({ type: 'worker:hello', workerId: WORKER_ID, capabilities: caps, activeRunIds: [...handles.keys()] })
    heartbeat = setInterval(() => {
      void send({ type: 'worker:heartbeat', workerId: WORKER_ID, activeRunIds: [...handles.keys()] })
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
        console.warn(
          `[worker] Ignoring additional run:assign ${msg.spec.runId} — one-shot already assigned`
        )
        return
      }
      acceptedAssignment = true
      void execute(msg.spec)
    } else if (msg.type === 'run:cancel') {
      console.log(`[worker] Cancel requested for run ${msg.runId}`)
      void handles.get(msg.runId)?.cancel()
    }
  })

  sock.on('close', (code, reason) => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    ws = null
    if (shuttingDown) return
    // One-shot: exit once a run was assigned so a dropped control plane does
    // not leave a billed Fargate task reconnecting. Before assignment, keep
    // reconnecting so startup blips can still complete assignTo.
    if (planAfterDisconnect() === 'exit' && acceptedAssignment) {
      console.warn(`[worker] Disconnected (${code} ${reason}) — one-shot worker exiting`)
      void shutdown()
      return
    }
    // Pooled (and one-shot pre-assignment): runs keep executing locally;
    // events drop while disconnected and run:exit is delivered on reconnect.
    console.warn(`[worker] Disconnected (${code} ${reason}) — reconnecting in ${reconnectDelayMs}ms`)
    setTimeout(connect, reconnectDelayMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000)
  })

  sock.on('error', (err) => {
    console.error('[worker] WebSocket error:', err.message)
  })
}

const shutdown = createIdempotentShutdown(async () => {
  shuttingDown = true
  if (heartbeat) clearInterval(heartbeat)
  console.log(`[worker] Shutting down — cancelling ${handles.size} active run(s)`)
  await factory.shutdown()
  handles.clear()
  try {
    ws?.close(1001, 'worker shutting down')
  } catch {
    // best-effort
  }
  // Give the close frame a moment to flush before exiting.
  await new Promise<void>((resolve) => setTimeout(resolve, 500))
  process.exit(0)
})

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

sweepStaleArtifacts()
connect()
