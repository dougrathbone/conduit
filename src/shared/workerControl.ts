/**
 * Worker control-plane protocol — the messages exchanged between the Conduit
 * server and conduit-worker processes over the secure WebSocket at /ws/worker.
 * Types only, shared by both sides (mirrors shared/observability.ts style).
 *
 * This is a separate, simpler envelope than the browser JSON-RPC on /ws: the
 * worker channel is fully event-driven in both directions. Authentication
 * happens once at the WS upgrade (Authorization: Bearer <CONDUIT_WORKER_TOKEN>);
 * there is no per-message auth.
 *
 * Flow:
 *   worker → server  worker:hello      (on (re)connect, with capabilities)
 *   worker → server  worker:heartbeat  (every 30s, with active run ids — the lease)
 *   server → worker  run:assign        (dispatch a RunSpec)
 *   worker → server  run:started       (workspace resolved, execution live)
 *   worker → server  run:event         (batched structured events)
 *   worker → server  run:exit          (terminal state)
 *   server → worker  run:cancel        (stop request)
 *
 * Lease semantics: if the server misses heartbeats from a worker for longer
 * than the lease window, it treats the worker as dead and fails its active
 * runs (via a synthesized run:exit to the run's event sink).
 */
import type { RunnerType } from './types'
import type { RunSpec, WorkerExitStatus } from './worker'
import type { RunEventInit } from './types'

export interface WorkerCapabilities {
  /** Runner CLIs available on the worker's PATH. */
  runners: RunnerType[]
  /** conduit-worker build/protocol version, for debugging skew. */
  version: string
}

// ── Worker → Server ─────────────────────────────────────────────────────────

export interface WorkerHelloMessage {
  type: 'worker:hello'
  workerId: string
  capabilities: WorkerCapabilities
  /** Run ids still executing on this worker across a reconnect (informational;
   *  the server cannot re-adopt their event streams after a restart). */
  activeRunIds: string[]
}

export interface WorkerHeartbeatMessage {
  type: 'worker:heartbeat'
  workerId: string
  activeRunIds: string[]
}

export interface WorkerRunStartedMessage {
  type: 'run:started'
  runId: string
  workspacePath?: string
}

export interface WorkerRunEventMessage {
  type: 'run:event'
  runId: string
  events: RunEventInit[]
}

export interface WorkerRunExitMessage {
  type: 'run:exit'
  runId: string
  status: WorkerExitStatus
  exitCode?: number | null
}

export type WorkerToServerMessage =
  | WorkerHelloMessage
  | WorkerHeartbeatMessage
  | WorkerRunStartedMessage
  | WorkerRunEventMessage
  | WorkerRunExitMessage

// ── Server → Worker ─────────────────────────────────────────────────────────

export interface ServerRunAssignMessage {
  type: 'run:assign'
  spec: RunSpec
}

export interface ServerRunCancelMessage {
  type: 'run:cancel'
  runId: string
}

export type ServerToWorkerMessage = ServerRunAssignMessage | ServerRunCancelMessage

// ── Tuning ──────────────────────────────────────────────────────────────────

/** How often a worker heartbeats. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000
/** How long the server tolerates silence before declaring a worker dead
 *  (2.5 missed beats absorbs transient network partitions). */
export const WORKER_LEASE_MS = 75_000
