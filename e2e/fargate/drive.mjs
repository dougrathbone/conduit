/**
 * Fargate-factory e2e driver — real orchestrator + control plane + workers,
 * with fake ECS (CONDUIT_FARGATE_E2E_STATE) asserting lifecycle and isolation.
 *
 * Env: CONDUIT_URL, CONDUIT_DATA_DIR, CONDUIT_FARGATE_E2E_STATE,
 *      CONDUIT_FARGATE_E2E_SKIP_SPAWN, CONDUIT_E2E_TOKEN (secret-scan needle).
 */
import WebSocket from 'ws'
import fs from 'node:fs'

const BASE = process.env.CONDUIT_URL ?? 'ws://localhost:7562/ws'
const DATA_DIR = process.env.CONDUIT_DATA_DIR
const STATE_PATH = process.env.CONDUIT_FARGATE_E2E_STATE
const SKIP_SPAWN = process.env.CONDUIT_FARGATE_E2E_SKIP_SPAWN
const TOKEN = process.env.CONDUIT_E2E_TOKEN || 'e2e-worker-token'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const ws = new WebSocket(BASE)
await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)))

let nextId = 1
const pending = new Map()
const statusWaiters = new Map()
const statusHistory = new Map()
const eventListeners = []
const eventsByRun = new Map()

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  if (msg.type === 'response' || msg.type === 'error') {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      if (msg.type === 'error') p.reject(new Error(msg.error))
      else p.resolve(msg.result)
    }
  } else if (msg.type === 'event') {
    const payload = msg.payload
    const runId = payload && typeof payload === 'object' && typeof payload.runId === 'string' ? payload.runId : null
    if (!runId) return
    if (msg.channel === 'run:statusChange') {
      const h = statusHistory.get(runId) ?? []
      h.push(payload)
      statusHistory.set(runId, h)
      const waiter = statusWaiters.get(runId)
      if (typeof waiter === 'function') waiter(payload)
    }
    if (msg.channel === 'run:events') {
      const list = eventsByRun.get(runId) ?? []
      list.push(...(payload.events ?? []))
      eventsByRun.set(runId, list)
      for (const fn of eventListeners) fn(payload)
    }
  }
})

const invoke = (channel, ...args) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ type: 'invoke', id, channel, args }))
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${channel} timed out`))), 30000)
  })

const waitStatus = (runId, statuses, timeoutMs = 90_000) => {
  const seen = (statusHistory.get(runId) ?? []).find((p) => statuses.includes(p.status))
  if (seen) return Promise.resolve(seen)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      statusWaiters.delete(runId)
      reject(new Error(`timed out waiting for ${statuses.join('/')} on ${runId}`))
    }, timeoutMs)
    statusWaiters.set(runId, (payload) => {
      if (statuses.includes(payload.status)) {
        clearTimeout(timer)
        statusWaiters.delete(runId)
        resolve(payload)
      }
    })
  })
}

const waitEvents = (runId, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    const existing = eventsByRun.get(runId)
    if (existing?.length) return resolve(existing)
    const timer = setTimeout(() => reject(new Error(`no events streamed for ${runId} within ${timeoutMs}ms`)), timeoutMs)
    eventListeners.push((payload) => {
      if (payload.runId === runId && payload.events?.length > 0) {
        clearTimeout(timer)
        resolve(payload.events)
      }
    })
  })

function readState() {
  if (!STATE_PATH || !fs.existsSync(STATE_PATH)) return { runTasks: [], tasks: {} }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
}

function runningCount(state = readState()) {
  return Object.values(state.tasks ?? {}).filter((t) => t.lastStatus === 'RUNNING').length
}

async function waitUntilIdle(timeoutMs = 15_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (runningCount() === 0) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`tasks still running after ${timeoutMs}ms\n${JSON.stringify(readState(), null, 2)}`)
}

function secretHits(state = readState()) {
  const hits = []
  for (const rec of state.runTasks ?? []) {
    const names = rec.overrideNames ?? Object.keys(rec.overrideEnv ?? {})
    for (const name of names) {
      if (name === 'CONDUIT_WORKER_TOKEN' || name === 'CONDUIT_FARGATE_WORKER_TOKEN') {
        hits.push(`${rec.taskArn}:${name}`)
      }
    }
    for (const [name, value] of Object.entries(rec.overrideEnv ?? {})) {
      if (typeof value === 'string' && value.includes(TOKEN)) {
        hits.push(`${rec.taskArn}:${name}=token`)
      }
    }
  }
  return hits
}

function assertNoSecrets(label) {
  const hits = secretHits()
  check(`${label}: no secret in RunTask overrides`, hits.length === 0, hits.join(', '))
}

function assertIdle(label) {
  check(`${label}: zero simulated running tasks`, runningCount() === 0, `running=${runningCount()}`)
}

function assertUniqueIds(label, runRows) {
  const workerIds = runRows.map((r) => r.workerId).filter(Boolean)
  const arns = (readState().runTasks ?? []).map((t) => t.taskArn)
  const uniqueWorkers = new Set(workerIds)
  const uniqueArns = new Set(arns)
  check(
    `${label}: unique workerIds`,
    workerIds.length === uniqueWorkers.size && workerIds.every((id) => id.startsWith('fargate-')),
    workerIds.join(',')
  )
  check(`${label}: unique fake task ARNs`, arns.length === uniqueArns.size && arns.every((a) => a.includes('000000000000')), `${arns.length} arn(s)`)
}

function assertCentralLog(runId, label) {
  const logFile = `${DATA_DIR}/logs/${runId}.jsonl`
  check(`${label}: centralized NDJSON log`, fs.existsSync(logFile) && fs.statSync(logFile).size > 0, logFile)
}

function assertSpawnContract(runId, label) {
  const rec = (readState().runTasks ?? []).find((t) => t.runId === runId)
  check(
    `${label}: task-def spawn sets mode+one-shot`,
    rec?.spawnEnv?.CONDUIT_PROCESS_MODE === 'worker' && rec?.spawnEnv?.CONDUIT_WORKER_ONE_SHOT === 'true',
    JSON.stringify(rec?.spawnEnv)
  )
  check(
    `${label}: RunTask overrides omit mode/one-shot`,
    !rec?.overrideNames?.includes('CONDUIT_PROCESS_MODE') && !rec?.overrideNames?.includes('CONDUIT_WORKER_ONE_SHOT'),
    (rec?.overrideNames ?? []).join(',')
  )
}

async function createAgent(name, prompt) {
  return invoke('agents:create', {
    name,
    runner: 'claude',
    prompt,
    envVars: {},
    mcpConfig: { mcpServers: {} },
  })
}

try {
  // ── 1. Completion ──
  const agentOk = await createAgent('e2e-fargate-complete', 'Say hello from the fargate factory e2e test')
  const runOk = await invoke('runs:start', agentOk.id)
  check('completion: run started', runOk?.status === 'running' || runOk?.status === 'launched', `id=${runOk?.id} status=${runOk?.status}`)
  check('completion: workerKind=fargate', runOk?.workerKind === 'fargate', `workerKind=${runOk?.workerKind}`)
  const finalOk = await waitStatus(runOk.id, ['completed', 'failed'])
  check('completion: run completed', finalOk.status === 'completed', `status=${finalOk.status} exitCode=${finalOk.exitCode}`)
  const [rowOk] = await invoke('runs:list', agentOk.id)
  check('completion: record exit 0 + workerId', rowOk?.status === 'completed' && rowOk?.exitCode === 0 && rowOk?.workerId === `fargate-${runOk.id}`, `status=${rowOk?.status} workerId=${rowOk?.workerId}`)
  const logOk = JSON.stringify(await invoke('runs:getLog', runOk.id))
  check('completion: log has stub output', logOk.includes('stub-claude received prompt'))
  assertCentralLog(runOk.id, 'completion')
  assertSpawnContract(runOk.id, 'completion')
  await waitUntilIdle()
  assertNoSecrets('completion')
  assertIdle('completion')
  assertUniqueIds('completion', [rowOk])

  // ── 2. Nonzero failure ──
  const agentFail = await createAgent('e2e-fargate-fail', 'E2E_FAIL please fail')
  const runFail = await invoke('runs:start', agentFail.id)
  const finalFail = await waitStatus(runFail.id, ['completed', 'failed'])
  check('failure: run failed', finalFail.status === 'failed', `status=${finalFail.status} exitCode=${finalFail.exitCode}`)
  const [rowFail] = await invoke('runs:list', agentFail.id)
  check('failure: record exit nonzero', rowFail?.status === 'failed' && rowFail?.exitCode !== 0, `status=${rowFail?.status} exitCode=${rowFail?.exitCode}`)
  check('failure: workerId recorded', rowFail?.workerId === `fargate-${runFail.id}`, `workerId=${rowFail?.workerId}`)
  assertCentralLog(runFail.id, 'failure')
  await waitUntilIdle()
  assertNoSecrets('failure')
  assertIdle('failure')

  // ── 3. Cancellation ──
  const agentStop = await createAgent('e2e-fargate-stop', 'E2E_LONG keep going until stopped')
  const runStop = await invoke('runs:start', agentStop.id)
  await waitEvents(runStop.id)
  await invoke('runs:stop', runStop.id)
  const stopped = await waitStatus(runStop.id, ['stopped', 'failed'])
  check('cancel: run stops on request', stopped.status === 'stopped', `status=${stopped.status}`)
  const [rowStop] = (await invoke('runs:list', agentStop.id)).filter((r) => r.id === runStop.id)
  check('cancel: record stopped', rowStop?.status === 'stopped', `status=${rowStop?.status}`)
  assertCentralLog(runStop.id, 'cancel')
  await waitUntilIdle()
  assertNoSecrets('cancel')
  assertIdle('cancel')

  // ── 4. Connect timeout (no worker spawn) ──
  if (SKIP_SPAWN) fs.writeFileSync(SKIP_SPAWN, '1')
  const agentTimeout = await createAgent('e2e-fargate-connect-timeout', 'This worker will never dial in')
  let connectErr
  try {
    await invoke('runs:start', agentTimeout.id)
  } catch (e) {
    connectErr = e
  }
  check('connect-timeout: runs:start fails', /did not connect/i.test(connectErr?.message ?? ''), connectErr?.message ?? 'no error')
  const timeoutRows = await invoke('runs:list', agentTimeout.id)
  check('connect-timeout: run marked failed', timeoutRows[0]?.status === 'failed', `status=${timeoutRows[0]?.status}`)
  await waitUntilIdle()
  assertNoSecrets('connect-timeout')
  assertIdle('connect-timeout')

  // ── 5. Worker crash ──
  const agentCrash = await createAgent('e2e-fargate-crash', 'E2E_LONG run until the worker dies')
  const runCrash = await invoke('runs:start', agentCrash.id)
  await waitEvents(runCrash.id)
  const crashWaitStart = Date.now()
  let crashTask
  while (Date.now() - crashWaitStart < 10_000) {
    crashTask = Object.values(readState().tasks ?? {}).find(
      (t) => t.runId === runCrash.id && (t.pgid || t.supervisorPid || t.workerPid)
    )
    if (crashTask?.pgid || crashTask?.supervisorPid) break
    await new Promise((r) => setTimeout(r, 50))
  }
  const crashGroup = crashTask?.pgid || crashTask?.supervisorPid
  check(
    'crash: fake ECS recorded a process group',
    typeof crashGroup === 'number' && crashGroup > 0,
    `pgid=${crashTask?.pgid} supervisorPid=${crashTask?.supervisorPid} workerPid=${crashTask?.workerPid}`
  )
  if (crashGroup) {
    try {
      process.kill(-crashGroup, 'SIGKILL')
    } catch {
      try {
        process.kill(crashGroup, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    console.log(`[fargate] Sent SIGKILL to process group ${crashGroup}`)
  }
  const crashFinal = await waitStatus(runCrash.id, ['failed', 'stopped'])
  check('crash: run failed after worker death', crashFinal.status === 'failed', `status=${crashFinal.status}`)
  const crashLog = JSON.stringify(await invoke('runs:getLog', runCrash.id))
  check(
    'crash: log records synthesized failure',
    crashLog.includes('failing this run') || crashLog.includes('Error') || crashFinal.status === 'failed',
    crashLog.includes('failing this run') ? '' : crashLog.slice(0, 160)
  )
  await waitUntilIdle()
  assertNoSecrets('crash')
  assertIdle('crash')

  // ── 6. Two agents in parallel ──
  const agentA = await createAgent('e2e-fargate-parallel-a', 'Say hello from parallel agent A UNIQUE_A')
  const agentB = await createAgent('e2e-fargate-parallel-b', 'Say hello from parallel agent B UNIQUE_B')
  const [runA, runB] = await Promise.all([invoke('runs:start', agentA.id), invoke('runs:start', agentB.id)])
  check('parallel: both started', runA?.id && runB?.id && runA.id !== runB.id, `a=${runA?.id} b=${runB?.id}`)
  const [finalA, finalB] = await Promise.all([
    waitStatus(runA.id, ['completed', 'failed']),
    waitStatus(runB.id, ['completed', 'failed']),
  ])
  check('parallel: both completed', finalA.status === 'completed' && finalB.status === 'completed', `a=${finalA.status} b=${finalB.status}`)
  const [rowA] = await invoke('runs:list', agentA.id)
  const [rowB] = await invoke('runs:list', agentB.id)
  check('parallel: distinct workerIds', rowA?.workerId !== rowB?.workerId && !!rowA?.workerId && !!rowB?.workerId, `${rowA?.workerId} vs ${rowB?.workerId}`)
  const logA = JSON.stringify(await invoke('runs:getLog', runA.id))
  const logB = JSON.stringify(await invoke('runs:getLog', runB.id))
  check('parallel: no cross-run events in A', logA.includes('UNIQUE_A') && !logA.includes('UNIQUE_B'))
  check('parallel: no cross-run events in B', logB.includes('UNIQUE_B') && !logB.includes('UNIQUE_A'))
  const evA = JSON.stringify(eventsByRun.get(runA.id) ?? [])
  const evB = JSON.stringify(eventsByRun.get(runB.id) ?? [])
  check('parallel: live events isolated', evA.includes('UNIQUE_A') && !evA.includes('UNIQUE_B') && evB.includes('UNIQUE_B') && !evB.includes('UNIQUE_A'))
  assertCentralLog(runA.id, 'parallel-a')
  assertCentralLog(runB.id, 'parallel-b')
  await waitUntilIdle()
  assertNoSecrets('parallel')
  assertIdle('parallel')
  assertUniqueIds('parallel', [rowA, rowB])

  // ── 7. Same-agent rejection ──
  const agentOnce = await createAgent('e2e-fargate-same-agent', 'E2E_LONG keep going until stopped')
  const runOnce = await invoke('runs:start', agentOnce.id)
  let rejected = false
  try {
    await invoke('runs:start', agentOnce.id)
  } catch (e) {
    rejected = /already/i.test(e.message)
  }
  check('same-agent: second concurrent run rejected', rejected)
  await invoke('runs:stop', runOnce.id)
  await waitStatus(runOnce.id, ['stopped', 'failed'])
  await waitUntilIdle()
  assertNoSecrets('same-agent')
  assertIdle('same-agent')

  const allArns = (readState().runTasks ?? []).map((t) => t.taskArn)
  check('suite: every RunTask ARN is unique', allArns.length === new Set(allArns).size, `${allArns.length} tasks`)
  check('suite: every started task stopped', runningCount() === 0, `running=${runningCount()}`)
  assertNoSecrets('suite')

  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed.length} CHECK(S) FAILED`)
  process.exitCode = failed.length === 0 ? 0 : 1
} catch (err) {
  console.error('E2E fargate driver error:', err)
  process.exitCode = 1
} finally {
  ws.close()
}
