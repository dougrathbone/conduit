import * as fs from 'fs'
import * as path from 'path'
import type { ExecutionRun, RunEvent, RunEventInit, TriggerContext, RunnerType } from '../shared/types'
import type { RunSpec, WorkspaceSpec, WorkerEventSink, WorkerHandle } from '../shared/worker'
import { summarizeEvent } from '../shared/runEvents'
import { createRun, updateRun, getRunningRunForAgent } from '../main/db/queries/runs'
import { getAgent } from '../main/db/queries/agents'
import { getRepository } from '../main/db/queries/repositories'
import { getCredentialValue } from '../main/db/queries/agentCredentials'
import { getRunnerTimeout } from '../main/db/queries/runnerSettings'
import { resolveBgTaskTimeoutSeconds, bgTaskTimeoutEnvEntry } from './runnerTimeout'
import { deleteWorkspace } from '../main/execution/workspace'
import { buildMcpConfigContent, deleteMcpConfig } from '../main/utils/mcp'
import { deleteClaudeConfig } from '../main/utils/claudeConfig'
import { DEV_USER_ID } from './auth/config'
import { LOGS_DIR } from '../main/utils/paths'
import { removeWorktree } from './gitOps'
import { buildRunFailureReport } from './runFailure'
import { resolvePushCredential, githubTokenEnvEntry } from './githubApp'
import { publishRunResult } from './publisher'
import { buildTriggeredPrompt } from './triggers/promptBuilder'
import { reporter } from './observability'
import { getWorkerFactory } from './workers'

/**
 * Run orchestrator. Owns everything about a run EXCEPT execution: DB records,
 * log persistence, browser broadcasts, credential resolution, publishing, and
 * post-run cleanup. Execution (workspace materialization, process spawn,
 * event streaming, cancellation) is delegated to the configured WorkerFactory
 * (see src/server/workers/) via a fully-resolved, serializable RunSpec — so
 * the agent can run in-process (local), in a conduit-worker process (remote),
 * or on EKS/Fargate without this file changing.
 */

/** Function signature for broadcasting events to all connected WebSocket clients */
export type BroadcastFn = (channel: string, payload: unknown) => void

/** Environment variable each runner reads its API key/token from. */
const RUNNER_ENV_VAR: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  amp: 'AMP_API_KEY',
  cursor: 'CURSOR_API_KEY',
}

/**
 * Build the RunSpec env overlay for a run: the agent's explicit envVars, then
 * the acting user's stored runner credential (Settings screen) injected as the
 * runner's API-key env var, the resolved background-task timeout injected as
 * the runner's wait-ceiling env var, and the resolved repo credential exposed
 * as GH_TOKEN for the `gh` CLI. An explicit per-agent envVar always wins over
 * every injected value. The worker applies this overlay on top of its own
 * process env at spawn time.
 */
async function buildRunnerEnvOverlay(
  agent: { runner: string; envVars?: Record<string, string>; ownerId?: string; bgTaskTimeoutSeconds?: number },
  startedBy?: string,
  githubToken?: string
): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...(agent.envVars ?? {}) }
  const ownerId = startedBy || agent.ownerId || DEV_USER_ID

  // Expose the repo's git credential as GH_TOKEN so the `gh` CLI authenticates as
  // the same identity `git push` uses. Only set when a token resolved (pat/
  // githubapp repos); ssh/none and repo-less runs leave `gh` unauthenticated.
  Object.assign(env, githubTokenEnvEntry(githubToken, agent.envVars))

  const envVar = RUNNER_ENV_VAR[agent.runner]
  if (envVar && !(agent.envVars && envVar in agent.envVars)) {
    try {
      const cred = await getCredentialValue(ownerId, agent.runner as 'claude' | 'amp' | 'cursor')
      if (cred) env[envVar] = cred
    } catch (err) {
      console.error(`[server/runner] Failed to load ${agent.runner} credential for ${ownerId}:`, err)
    }
  }

  // Background-task timeout: agent override → user's per-provider Settings value
  // → 0 (run indefinitely). Injected as the runner's wait-ceiling env var.
  try {
    const userSeconds = await getRunnerTimeout(ownerId, agent.runner as RunnerType)
    const effective = resolveBgTaskTimeoutSeconds(agent.bgTaskTimeoutSeconds, userSeconds)
    Object.assign(env, bgTaskTimeoutEnvEntry(agent.runner, effective, agent.envVars))
  } catch (err) {
    console.error(`[server/runner] Failed to resolve bg-task timeout for ${ownerId}:`, err)
  }

  return env
}

interface ActiveRun {
  handle: WorkerHandle
  finalize: (status: 'completed' | 'failed' | 'stopped', exitCode?: number | null) => void
  /** The run's workspace dir (git worktree or ephemeral tmp dir). Used by the
   *  data-dir sweeper to avoid deleting a running run's workspace. */
  workspacePath: string
  /** The agent this run belongs to — used to enforce one live run per agent. */
  agentId: string
}

// Active runs keyed by runId
const activeProcesses = new Map<string, ActiveRun>()

/** Whether an agent already has a run executing on this pod. One streaming run
 *  per agent at a time: a second concurrent run would double the (multi-GB)
 *  worktree footprint and race the same workspace. */
export function hasActiveRunForAgent(agentId: string): boolean {
  for (const r of activeProcesses.values()) {
    if (r.agentId === agentId) return true
  }
  return false
}

/** Workspace dirs of runs currently executing on this pod. The data-dir sweeper
 *  treats these as protected — never sweeps a live run's worktree/workspace. */
export function getActiveWorkspacePaths(): Set<string> {
  return new Set(
    [...activeProcesses.values()].map((r) => r.workspacePath).filter((p): p is string => !!p)
  )
}

/** RunIds currently executing on this pod (used to protect per-run tmp files
 *  like MCP config, whose names embed the runId). */
export function getActiveRunIds(): Set<string> {
  return new Set(activeProcesses.keys())
}

// Hook invoked after each run reaches a terminal state and has been removed from
// the active set. The server wires this to the data-dir sweeper so disk is
// reclaimed promptly after every job finishes. Declared here (rather than
// importing the sweeper) to avoid a runner ↔ dataDirSweeper circular import.
let runFinalizedHook: (() => void) | null = null
export function setRunFinalizedHook(cb: (() => void) | null): void {
  runFinalizedHook = cb
}
function notifyRunFinalized(): void {
  try {
    runFinalizedHook?.()
  } catch (err) {
    console.error('[server/runner] run-finalized hook threw:', err)
  }
}

/** Delay before removing a run's workspace, so executables it spawned can exit
 *  and release file handles before we delete the directory. */
const WORKSPACE_CLEANUP_DELAY_MS = 30_000

/** Per-run cap on the on-disk log file (`logs/<runId>.jsonl`). A runaway run —
 *  e.g. one looping and spewing output — could otherwise write gigabytes that the
 *  data-dir sweeper never reclaims (run logs are history, not swept until they
 *  age out). Past the cap we stop persisting to disk (writing one truncation
 *  marker); live streaming to the UI and stdout log-forwarding continue. `0`
 *  disables the cap. */
const RUN_LOG_MAX_BYTES = (() => {
  const n = Number(process.env.CONDUIT_RUN_LOG_MAX_BYTES)
  return Number.isFinite(n) && n >= 0 ? n : 500 * 1024 * 1024 // 500 MB
})()

/** Append a system event to a run's log file (used after the log stream is
 *  closed, e.g. by the delayed cleanup). Also emits to stdout for log forwarding. */
export function appendRunLog(runId: string, text: string): void {
  const event: RunEvent = { t: Date.now(), kind: 'raw', stream: 'system', text }
  try {
    fs.appendFileSync(path.join(LOGS_DIR, `${runId}.jsonl`), JSON.stringify(event) + '\n')
  } catch (err) {
    console.error(`[runner] Failed to append cleanup log for run ${runId}: ${err}`)
  }
  process.stdout.write(JSON.stringify({ runId, ...event }) + '\n')
}

/**
 * Cleanup helper for a finished run. Removes the run's MCP config immediately
 * (it carries a token), then — after a short delay so spawned executables can
 * exit — removes the run's workspace (git worktree or ephemeral dir) and logs
 * the outcome to the run's log. A fixed `workingDir` is never deleted.
 */
function cleanupRun(
  runId: string,
  workspacePath: string | undefined,
  ephemeral: boolean,
  worktreeClonePath?: string
): void {
  deleteMcpConfig(runId)
  deleteClaudeConfig(runId)
  const removable = !!workspacePath && (!!worktreeClonePath || ephemeral)
  if (!removable) return

  setTimeout(() => {
    void (async () => {
      try {
        if (worktreeClonePath) {
          await removeWorktree(worktreeClonePath, workspacePath!)
        } else {
          deleteWorkspace(workspacePath!)
        }
      } catch (err) {
        console.error(`[runner] Workspace cleanup error for run ${runId}: ${err}`)
      }
      // removeWorktree/deleteWorkspace swallow errors internally, so verify by
      // checking the directory is actually gone.
      if (fs.existsSync(workspacePath!)) {
        appendRunLog(runId, `⚠ Failed to clean up run workspace — ${workspacePath} still present.`)
      } else {
        appendRunLog(runId, `✓ Cleaned up run workspace (${workspacePath}).`)
      }
    })()
  }, WORKSPACE_CLEANUP_DELAY_MS)
}

/**
 * Start an agent run in server mode.
 *
 * Orchestrates the run (DB record, log stream, broadcasts, publish) and
 * delegates execution to the configured WorkerFactory with a fully-resolved
 * RunSpec. Events stream back through the WorkerEventSink.
 */
export async function startRunServer(
  agentId: string,
  broadcast: BroadcastFn,
  triggerContext?: TriggerContext,
  startedBy?: string
): Promise<ExecutionRun> {
  // 1. Load agent
  const agent = await getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)

  // One live run per agent: reject a second concurrent start rather than spin up
  // another multi-GB worktree racing the same agent. Checked both against this
  // pod's active set (fast path) and the DB (holds across factories and pods).
  if (hasActiveRunForAgent(agentId) || (await getRunningRunForAgent(agentId))) {
    throw new Error(
      `Agent "${agent.name || agentId}" already has a run in progress. ` +
        `Stop it before starting another.`
    )
  }

  // 2. Determine the workspace spec: repo worktree (local factory, off the
  //    server-side bare clone) > repo clone (remote workers, fresh from the
  //    remote) > fixed workingDir (local only) > ephemeral. Materialization
  //    happens inside the worker factory.
  const factory = getWorkerFactory()
  let workspaceSpec: WorkspaceSpec
  // Set when push-credential resolution failed; surfaced into the run log once
  // the log stream is open (see below), so a broken git token is never invisible.
  let pushCredentialError: string | undefined
  // The resolved repo credential (global PAT / minted GitHub-App installation
  // token). Tokenizes the checkout's `origin` for `git push` AND is handed to
  // the agent as GH_TOKEN so the `gh` CLI authenticates as the same identity.
  let pushToken: string | undefined

  if (agent.repositoryId) {
    const repo = await getRepository(agent.repositoryId)
    if (!repo) throw new Error(`Repository ${agent.repositoryId} not found`)
    if (factory.kind === 'local' && repo.syncStatus !== 'ready') {
      // The local factory worktrees off the server-side bare clone, so it must
      // be synced; remote factories clone from the remote and don't use it.
      throw new Error(
        `Repository "${repo.name}" is not ready (status: ${repo.syncStatus}).` +
        (repo.syncError ? ` Error: ${repo.syncError}` : ' Please wait for sync to complete.')
      )
    }
    // Resolve push credentials (non-throwing) so the token can travel in the
    // RunSpec for the worker to inject into the checkout's origin. A failed
    // mint is recorded, not fatal — the agent's later `git push` fails with an
    // opaque credential error otherwise, so record why in both Sentry and the
    // run log (the run-log line is emitted below, once the log stream is open).
    const { token: resolvedToken, error: pushTokenError } = await resolvePushCredential(repo)
    pushToken = resolvedToken
    if (pushTokenError) {
      pushCredentialError = pushTokenError.message
      reporter.captureException(pushTokenError, {
        tags: { component: 'runner', op: 'resolvePushCredential', repoId: repo.id },
      })
      console.error(`[server/runner] Could not resolve push credentials for repo ${repo.id}:`, pushTokenError)
    }
    const specRepo = {
      url: repo.url,
      defaultBranch: repo.defaultBranch,
      token: pushToken,
      authorName: repo.commitAuthorName?.trim() || 'Conduit',
      authorEmail: repo.commitAuthorEmail?.trim() || 'conduit@dovetail.com',
    }
    workspaceSpec =
      factory.kind === 'local'
        ? {
            kind: 'worktree',
            clonePath: repo.clonePath!,
            worktreeDir: path.join(repo.clonePath!, 'worktrees-run', crypto.randomUUID()),
            repo: specRepo,
          }
        : { kind: 'repo-clone', repo: specRepo }
  } else if (agent.workingDir) {
    if (factory.kind !== 'local') {
      throw new Error(
        `Agent "${agent.name || agentId}" uses a fixed working directory (${agent.workingDir}), ` +
          `which only exists on the server host — it cannot run on a remote worker.`
      )
    }
    workspaceSpec = { kind: 'fixedDir', path: agent.workingDir }
  } else {
    workspaceSpec = { kind: 'ephemeral' }
  }

  const actingUserId = startedBy ?? agent.ownerId ?? DEV_USER_ID

  // 3. Create run record (log path updated once we have the runId;
  //    workspacePath updated once the worker resolves it).
  const runRecord = await createRun({
    agentId,
    status: 'running',
    startedAt: Date.now(),
    workspacePath: undefined,
    logPath: path.join(LOGS_DIR, `__pending__.jsonl`), // placeholder
    exitCode: undefined,
    endedAt: undefined,
    durationMs: undefined,
    triggerContext: triggerContext ?? undefined,
    startedBy: startedBy ?? undefined,
    workerKind: factory.kind,
  })

  const runId = runRecord.id
  const realLogPath = path.join(LOGS_DIR, `${runId}.jsonl`)
  await updateRun(runId, { logPath: realLogPath })

  // 4. Materialize the MCP config content (global merge + OAuth tokens + env
  //    expansion) for the RunSpec. This can throw (e.g. an MCP OAuth token that
  //    can't be decrypted). Since the run record already exists, an unhandled
  //    throw here would leave it orphaned as "running" forever with no log — so
  //    on failure we mark it failed, record why in its log, and surface it.
  //    Skipped for cursor: cursor-agent has no --mcp-config flag (it loads MCPs
  //    from the workspace's .cursor/mcp.json and the user's global Cursor
  //    config), so Conduit-managed MCP injection doesn't apply to that runner.
  let mcpConfigContent: string | undefined
  try {
    if (agent.runner !== 'cursor') {
      mcpConfigContent = await buildMcpConfigContent(agent.mcpConfig, actingUserId)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendRunLog(runId, `Failed to prepare run: ${msg}`)
    cleanupRun(runId, undefined, false)
    await updateRun(runId, { status: 'failed', endedAt: Date.now(), lastLine: `Failed to prepare run: ${msg}` })
    broadcast('run:statusChange', { runId, status: 'failed' })
    reporter.captureException(err, { tags: { component: 'runner', op: 'prepareRun', runId } })
    throw err
  }

  // 5. Open log file write stream
  const logStream = fs.createWriteStream(realLogPath, { flags: 'a', encoding: 'utf8' })

  // Bytes written to the on-disk log so far, and whether the cap has been hit.
  let logBytesWritten = 0
  let logCapped = false

  // Persist one structured event to the run's log file (until the per-run size
  // cap), then forward it to the platform log pipeline. New runs store RunEvents
  // (one per NDJSON line); old runs' ANSI LogEntry logs still replay via the
  // format-detecting reader.
  function writeRunEvent(event: RunEvent): void {
    const line = JSON.stringify(event)
    if (!logCapped) {
      logStream.write(line + '\n')
      if (RUN_LOG_MAX_BYTES > 0) {
        logBytesWritten += Buffer.byteLength(line) + 1
        if (logBytesWritten >= RUN_LOG_MAX_BYTES) {
          logCapped = true
          logStream.write(
            JSON.stringify({
              t: Date.now(),
              kind: 'raw',
              stream: 'system',
              text: `[Conduit: run log truncated on disk — exceeded ${RUN_LOG_MAX_BYTES}-byte cap. Live output continues.]`,
            }) + '\n'
          )
        }
      }
    }
    // Always emit to stdout so the platform log forwarder (Datadog, etc.) ingests.
    process.stdout.write(JSON.stringify({ runId, agentId, ...event }) + '\n')
  }

  // Last meaningful activity (plain text) for the runs-list excerpt / live label.
  let lastLine = ''

  // Buffer + flush structured events into batched WebSocket broadcasts.
  const eventBuffer: RunEvent[] = []
  let flushScheduled = false
  function scheduleFlush(): void {
    if (flushScheduled) return
    flushScheduled = true
    setImmediate(() => {
      flushScheduled = false
      if (eventBuffer.length > 0) {
        const events = eventBuffer.splice(0)
        broadcast('run:events', { runId, events })
      }
    })
  }

  // Stamp, persist, summarize (for lastLine), and queue an event for broadcast.
  function emitEvent(init: RunEventInit): void {
    const event: RunEvent = { ...init, t: Date.now() }
    writeRunEvent(event)
    const summary = summarizeEvent(event)
    if (summary) lastLine = summary.slice(0, 500)
    eventBuffer.push(event)
    scheduleFlush()
  }

  function emitSystemMessage(text: string): void {
    emitEvent({ kind: 'raw', stream: 'system', text })
  }

  // Guard against double-finalization (e.g. stopRun + close event)
  let finalized = false

  // Workspace facts reported by the worker once execution starts; finalized
  // runs can only happen after that (events are asynchronous), so these are
  // always populated by the time finalizeRun runs.
  let workspacePath: string | undefined = undefined
  let isEphemeral = false
  let worktreeClonePath: string | undefined = undefined

  async function finalizeRun(
    status: 'completed' | 'failed' | 'stopped',
    exitCode: number | null | undefined
  ): Promise<void> {
    if (finalized) return
    finalized = true
    activeProcesses.delete(runId)
    cleanupRun(runId, workspacePath, isEphemeral, worktreeClonePath)

    // Flush any remaining buffered events
    if (eventBuffer.length > 0) {
      const events = eventBuffer.splice(0)
      broadcast('run:events', { runId, events })
    }

    logStream.end()

    const endedAt = Date.now()
    const durationMs = endedAt - runRecord.startedAt

    await updateRun(runId, {
      status,
      endedAt,
      durationMs,
      exitCode: exitCode ?? undefined,
      lastLine: lastLine || undefined,
    })
      .then((finalRun) => {
        broadcast('run:statusChange', {
          runId,
          status,
          exitCode: exitCode ?? undefined,
          endedAt,
          durationMs,
        })
        return publishRunResult(agentId, finalRun)
      })
      .catch((err) => console.error(`[server/runner] Finalize failed for run ${runId}:`, err))

    // Reclaim disk promptly after every job finishes (see setRunFinalizedHook).
    notifyRunFinalized()
  }

  // Surface a broken push credential into the run log so it's attributable at a
  // glance, rather than only showing up later as an opaque `git push` failure.
  if (pushCredentialError) {
    emitSystemMessage(
      `⚠️  Could not obtain GitHub push credentials for this repository: ${pushCredentialError}\n` +
      `   The agent can read the code, but "git push" (and opening PRs) will fail. ` +
      `Check the repository's authentication settings.`
    )
  }

  // Cursor loads MCPs from the workspace/user config, not from Conduit's
  // injected config — say so up front rather than silently ignoring them.
  if (agent.runner === 'cursor' && Object.keys(agent.mcpConfig?.mcpServers ?? {}).length > 0) {
    emitSystemMessage(
      `[Conduit: cursor-agent has no --mcp-config flag, so this agent's configured MCP ` +
        `servers are not injected. Cursor loads MCPs from the workspace .cursor/mcp.json ` +
        `and the user's global Cursor config.]`
    )
  }

  // 6. Build the fully-resolved RunSpec and hand execution to the worker
  //    factory. Events stream back through the sink into the pipeline above.
  const spec: RunSpec = {
    runId,
    agentId,
    runner: agent.runner,
    model: agent.model,
    effort: agent.effort,
    prompt: triggerContext ? buildTriggeredPrompt(agent.prompt, triggerContext) : agent.prompt,
    env: await buildRunnerEnvOverlay(agent, startedBy, pushToken),
    mcpConfigContent,
    strictMcpConfig: agent.runner === 'claude' ? !agent.enableRepoMcps : undefined,
    workspace: workspaceSpec,
  }

  const sink: WorkerEventSink = {
    onEvent: (init) => emitEvent(init),
    onError: (err) => {
      // Spawn-level failure (binary not on PATH, etc.)
      console.error(`[server/runner] Spawn error for run ${runId}:`, err)
      reporter.captureException(err, {
        tags: { component: 'runner', runId, runner: agent.runner },
      })
      emitSystemMessage(`\n[Error: ${err.message}]\n`)
      finalizeRun('failed', undefined)
    },
    onExit: (status, exitCode) => {
      // Surface failed runs to the error reporter — a non-zero exit (or a
      // process killed when the disk filled) was previously only written to
      // the DB and never captured. Skip when already finalized: a spawn error
      // or an explicit stopRun has its own handling and would double-report.
      if (status === 'failed' && !finalized) {
        const report = buildRunFailureReport({ runId, runner: agent.runner, exitCode, lastLine })
        reporter.captureMessage(report.message, report.level, report.ctx)
      }
      finalizeRun(status, exitCode)
    },
  }

  let handle: WorkerHandle
  try {
    handle = await factory.startRun(spec, sink)
  } catch (err) {
    // Rethrown to the caller (WS 'runs:start' handler / triggerService), which
    // reports it — capturing here too would double-report. The factory rolls
    // back any workspace/config it created before throwing.
    cleanupRun(runId, undefined, false)
    logStream.end()
    await updateRun(runId, { status: 'failed', endedAt: Date.now() })
    broadcast('run:statusChange', { runId, status: 'failed' })
    throw err
  }

  workspacePath = handle.workspacePath
  isEphemeral = handle.ephemeral
  worktreeClonePath = handle.worktreeClonePath

  activeProcesses.set(runId, {
    handle,
    finalize: finalizeRun,
    workspacePath: workspacePath ?? '',
    agentId,
  })

  // Record the resolved workspace path (worker-local for remote factories) and
  // the executing worker's identity.
  const run = await updateRun(runId, { workspacePath, workerId: handle.workerId })
  return run
}

/**
 * Stop a running agent by cancelling it through its worker handle.
 * Uses the finalize closure from startRunServer to ensure consistent cleanup.
 */
export async function stopRun(runId: string): Promise<void> {
  const activeRun = activeProcesses.get(runId)
  if (!activeRun) {
    console.warn(`[server/runner] stopRun called for unknown runId: ${runId}`)
    return
  }

  // Call the finalize closure first (marks finalized=true, prevents double-run on exit)
  await activeRun.finalize('stopped', null)

  // Then cancel execution — the exit will still arrive but finalizeRun will no-op
  try {
    await activeRun.handle.cancel()
  } catch (err) {
    console.error(`[server/runner] Failed to cancel run ${runId}:`, err)
  }
}
