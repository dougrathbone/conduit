import { spawn, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import type { ExecutionRun, LogEntry } from '../shared/types'
import { createRun, updateRun } from '../main/db/queries/runs'
import { getAgent } from '../main/db/queries/agents'
import { createWorkspace, deleteWorkspace } from '../main/execution/workspace'
import { writeMcpConfig, deleteMcpConfig, buildMergedMcpConfig } from '../main/utils/mcp'
import { LOGS_DIR } from '../main/utils/paths'
import { buildClaudeArgs, parseClaudeOutput } from '../main/execution/adapters/claude'
import { buildAmpArgs, parseAmpOutput } from '../main/execution/adapters/amp'
import { buildCursorArgs, CURSOR_NOTICE } from '../main/execution/adapters/cursor'

/** Function signature for broadcasting events to all connected WebSocket clients */
export type BroadcastFn = (channel: string, payload: unknown) => void

interface ActiveRun {
  child: ChildProcess
  finalize: (status: 'completed' | 'failed' | 'stopped', exitCode?: number | null) => void
}

// Active child processes keyed by runId
const activeProcesses = new Map<string, ActiveRun>()

/**
 * Cleanup helper: remove workspace + MCP config file for a run.
 */
function cleanupRun(runId: string, workspacePath: string | undefined, ephemeral: boolean): void {
  deleteMcpConfig(runId)
  if (ephemeral && workspacePath) {
    deleteWorkspace(workspacePath)
  }
}

/**
 * Start an agent run in server mode.
 *
 * Identical logic to src/main/execution/runner.ts startRun(), but uses the
 * provided `broadcast` function to push events to WebSocket clients instead
 * of mainWindow.webContents.send().
 */
export async function startRunServer(
  agentId: string,
  broadcast: BroadcastFn
): Promise<ExecutionRun> {
  // 1. Load agent
  const agent = getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)

  // 2. Determine workspace: use agent's fixed workingDir or create an ephemeral one
  const isEphemeral = !agent.workingDir
  const workspacePath = agent.workingDir ?? createWorkspace(agentId)

  // 4. Create run record (log path updated after we have the runId)
  const runRecord = createRun({
    agentId,
    status: 'running',
    startedAt: Date.now(),
    workspacePath,
    logPath: path.join(LOGS_DIR, `__pending__.jsonl`), // placeholder
    exitCode: undefined,
    endedAt: undefined,
    durationMs: undefined,
  })

  const runId = runRecord.id
  const realLogPath = path.join(LOGS_DIR, `${runId}.jsonl`)

  // Update run record with the real log path
  const run = updateRun(runId, { logPath: realLogPath })

  // 3b. Write MCP config now that we have the runId
  const mergedMcpConfig = buildMergedMcpConfig(agent.mcpConfig)
  const mcpConfigPath = writeMcpConfig(runId, mergedMcpConfig)

  // 5. Open log file write stream
  const logStream = fs.createWriteStream(realLogPath, { flags: 'a', encoding: 'utf8' })

  function writeLogEntry(entry: LogEntry): void {
    logStream.write(JSON.stringify(entry) + '\n')
  }

  function emitSystemMessage(chunk: string): void {
    const entry: LogEntry = { t: Date.now(), stream: 'system', chunk }
    writeLogEntry(entry)
    broadcast('run:output', { runId, stream: 'system', chunks: [chunk] })
  }

  // Buffer + flush helpers (batch rapid output into single WebSocket messages)
  const stdoutBuffer: string[] = []
  const stderrBuffer: string[] = []
  let flushScheduled = false

  function scheduleFlush(): void {
    if (flushScheduled) return
    flushScheduled = true
    setImmediate(() => {
      flushScheduled = false
      if (stdoutBuffer.length > 0) {
        const chunks = stdoutBuffer.splice(0)
        broadcast('run:output', { runId, stream: 'stdout', chunks })
      }
      if (stderrBuffer.length > 0) {
        const chunks = stderrBuffer.splice(0)
        broadcast('run:output', { runId, stream: 'stderr', chunks })
      }
    })
  }

  function handleStdoutChunk(chunk: string): void {
    const entry: LogEntry = { t: Date.now(), stream: 'stdout', chunk }
    writeLogEntry(entry)
    stdoutBuffer.push(chunk)
    scheduleFlush()
  }

  function handleStderrChunk(chunk: string): void {
    const entry: LogEntry = { t: Date.now(), stream: 'stderr', chunk }
    writeLogEntry(entry)
    stderrBuffer.push(chunk)
    scheduleFlush()
  }

  // Guard against double-finalization (e.g. stopRun + close event)
  let finalized = false

  function finalizeRun(
    status: 'completed' | 'failed' | 'stopped',
    exitCode: number | null | undefined
  ): void {
    if (finalized) return
    finalized = true
    activeProcesses.delete(runId)
    cleanupRun(runId, workspacePath, isEphemeral)

    // Flush any remaining buffered output
    if (stdoutBuffer.length > 0) {
      const chunks = stdoutBuffer.splice(0)
      broadcast('run:output', { runId, stream: 'stdout', chunks })
    }
    if (stderrBuffer.length > 0) {
      const chunks = stderrBuffer.splice(0)
      broadcast('run:output', { runId, stream: 'stderr', chunks })
    }

    logStream.end()

    const endedAt = Date.now()
    const durationMs = endedAt - run.startedAt

    updateRun(runId, {
      status,
      endedAt,
      durationMs,
      exitCode: exitCode ?? undefined,
    })

    broadcast('run:statusChange', {
      runId,
      status,
      exitCode: exitCode ?? undefined,
      endedAt,
      durationMs,
    })
  }

  // 6. Spawn process based on runner type
  if (agent.runner === 'cursor') {
    // Cursor: open workspace folder, no streaming
    let child: ChildProcess
    try {
      child = spawn('cursor', buildCursorArgs(workspacePath), {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    } catch (err) {
      cleanupRun(runId, workspacePath, isEphemeral)
      logStream.end()
      updateRun(runId, { status: 'failed', endedAt: Date.now() })
      broadcast('run:statusChange', { runId, status: 'failed' })
      throw err
    }

    emitSystemMessage(CURSOR_NOTICE)

    // Mark as launched (not completed — it's a GUI app)
    activeProcesses.delete(runId)
    cleanupRun(runId, workspacePath, isEphemeral)
    logStream.end()

    const endedAt = Date.now()
    const durationMs = endedAt - run.startedAt

    const launchedRun = updateRun(runId, { status: 'launched', endedAt, durationMs })

    broadcast('run:statusChange', { runId, status: 'launched', endedAt, durationMs })

    return launchedRun
  }

  // claude or amp
  let child: ChildProcess
  try {
    const cliArgs =
      agent.runner === 'amp'
        ? buildAmpArgs(mcpConfigPath)
        : buildClaudeArgs(mcpConfigPath)

    const binary = agent.runner === 'amp' ? 'amp' : 'claude'

    child = spawn(binary, cliArgs, {
      cwd: workspacePath,
      env: { ...process.env, ...agent.envVars },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Write prompt to stdin — avoids --mcp-config <configs...> greedily
    // consuming the prompt as an additional config path argument.
    if (child.stdin) {
      child.stdin.write(agent.prompt)
      child.stdin.end()
    }
  } catch (err) {
    cleanupRun(runId, workspacePath, isEphemeral)
    logStream.end()
    updateRun(runId, { status: 'failed', endedAt: Date.now() })
    broadcast('run:statusChange', { runId, status: 'failed' })
    throw err
  }

  activeProcesses.set(runId, { child, finalize: finalizeRun })

  // Handle spawn errors (binary not in PATH, etc.)
  child.on('error', (err) => {
    console.error(`[server/runner] Spawn error for run ${runId}:`, err)
    emitSystemMessage(`\n[Error: ${err.message}]\n`)
    finalizeRun('failed', undefined)
  })

  // Readline on stdout for NDJSON parsing
  const parseOutput = agent.runner === 'amp' ? parseAmpOutput : parseClaudeOutput

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      const parsed = parseOutput(line)
      if (parsed !== null) {
        // readline strips the newline — add \r\n so xterm renders on separate lines
        handleStdoutChunk(parsed + '\r\n')
      }
    })
  }

  // Stderr: stream raw
  if (child.stderr) {
    child.stderr.on('data', (data: Buffer) => {
      handleStderrChunk(data.toString('utf8'))
    })
  }

  // Process close
  child.on('close', (code) => {
    const status = code === 0 ? 'completed' : 'failed'
    finalizeRun(status, code)
  })

  return run
}

/**
 * Stop a running agent process by sending SIGTERM.
 * Uses the finalize closure from startRunServer to ensure consistent cleanup.
 */
export async function stopRun(runId: string): Promise<void> {
  const activeRun = activeProcesses.get(runId)
  if (!activeRun) {
    console.warn(`[server/runner] stopRun called for unknown runId: ${runId}`)
    return
  }

  // Call the finalize closure first (marks finalized=true, prevents double-run on close event)
  activeRun.finalize('stopped', null)

  // Then kill the process — the close event will fire but finalizeRun will no-op
  try {
    activeRun.child.kill('SIGTERM')
  } catch (err) {
    console.error(`[server/runner] Failed to kill process for run ${runId}:`, err)
  }
}
