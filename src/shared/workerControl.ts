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
  /** Echo of the assignId from run:assign; rejects stale starts after a retry. */
  assignId?: string
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
  /** Per-assignment token the worker echoes on run:started. */
  assignId: string
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
/** Reject worker frames larger than this. */
export const WORKER_MAX_MESSAGE_BYTES = 1_048_576
/** Reject run:event batches larger than this. */
export const WORKER_MAX_EVENT_BATCH = 256

export type WorkerMessageParseFailure = 'malformed' | 'invalid' | 'oversized-batch'

export type WorkerMessageParseResult =
  | { ok: true; message: WorkerToServerMessage }
  | { ok: false; error: WorkerMessageParseFailure }

const EXIT_STATUSES = new Set<WorkerExitStatus>(['completed', 'failed', 'stopped'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRunEventInit(value: unknown): value is RunEventInit {
  return isRecord(value) && typeof value.kind === 'string'
}

/** Parse and structurally validate a worker→server control-plane frame. */
export function parseWorkerToServerMessage(raw: string): WorkerMessageParseResult {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'malformed' }
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { ok: false, error: 'invalid' }
  }
  switch (value.type) {
    case 'worker:hello': {
      if (
        typeof value.workerId !== 'string' ||
        value.workerId.length === 0 ||
        !isRecord(value.capabilities) ||
        !isStringArray(value.capabilities.runners) ||
        typeof value.capabilities.version !== 'string' ||
        !isStringArray(value.activeRunIds)
      ) {
        return { ok: false, error: 'invalid' }
      }
      return {
        ok: true,
        message: {
          type: 'worker:hello',
          workerId: value.workerId,
          capabilities: {
            runners: value.capabilities.runners as WorkerCapabilities['runners'],
            version: value.capabilities.version,
          },
          activeRunIds: value.activeRunIds,
        },
      }
    }
    case 'worker:heartbeat': {
      if (typeof value.workerId !== 'string' || value.workerId.length === 0 || !isStringArray(value.activeRunIds)) {
        return { ok: false, error: 'invalid' }
      }
      return {
        ok: true,
        message: { type: 'worker:heartbeat', workerId: value.workerId, activeRunIds: value.activeRunIds },
      }
    }
    case 'run:started': {
      if (typeof value.runId !== 'string' || value.runId.length === 0) {
        return { ok: false, error: 'invalid' }
      }
      if (value.workspacePath !== undefined && typeof value.workspacePath !== 'string') {
        return { ok: false, error: 'invalid' }
      }
      if (value.assignId !== undefined && (typeof value.assignId !== 'string' || value.assignId.length === 0)) {
        return { ok: false, error: 'invalid' }
      }
      return {
        ok: true,
        message: {
          type: 'run:started',
          runId: value.runId,
          workspacePath: value.workspacePath,
          assignId: value.assignId,
        },
      }
    }
    case 'run:event': {
      if (typeof value.runId !== 'string' || value.runId.length === 0 || !Array.isArray(value.events)) {
        return { ok: false, error: 'invalid' }
      }
      if (value.events.length > WORKER_MAX_EVENT_BATCH) {
        return { ok: false, error: 'oversized-batch' }
      }
      if (!value.events.every(isRunEventInit)) {
        return { ok: false, error: 'invalid' }
      }
      return { ok: true, message: { type: 'run:event', runId: value.runId, events: value.events } }
    }
    case 'run:exit': {
      if (
        typeof value.runId !== 'string' ||
        value.runId.length === 0 ||
        typeof value.status !== 'string' ||
        !EXIT_STATUSES.has(value.status as WorkerExitStatus)
      ) {
        return { ok: false, error: 'invalid' }
      }
      if (
        value.exitCode !== undefined &&
        value.exitCode !== null &&
        typeof value.exitCode !== 'number'
      ) {
        return { ok: false, error: 'invalid' }
      }
      return {
        ok: true,
        message: {
          type: 'run:exit',
          runId: value.runId,
          status: value.status as WorkerExitStatus,
          exitCode: value.exitCode as number | null | undefined,
        },
      }
    }
    default:
      return { ok: false, error: 'invalid' }
  }
}
