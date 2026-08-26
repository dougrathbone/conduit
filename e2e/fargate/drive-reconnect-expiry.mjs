/**
 * Fargate reconnect-expiry driver.
 *
 * Starts a long run, signals the orchestrator to SIGKILL the server, then
 * asserts the simulated worker PID stays alive through a short injected
 * window, exits non-zero after it, and that the replacement server records
 * the reconnect-timeout diagnostic.
 *
 * Env: CONDUIT_URL, CONDUIT_DATA_DIR, CONDUIT_FARGATE_E2E_STATE,
 *      CONDUIT_WORKER_RECONNECT_TIMEOUT_MS (expected window, default 1200).
 * Handshake: EXPIRY_KILL_SERVER, then EXPIRY_START_REPLACEMENT after worker exit.
 */
import WebSocket from 'ws'
import fs from 'node:fs'

const BASE = process.env.CONDUIT_URL
const STATE_PATH = process.env.CONDUIT_FARGATE_E2E_STATE
const TIMEOUT_MS = Number(process.env.CONDUIT_WORKER_RECONNECT_TIMEOUT_MS) || 1200
const LOWER_MS = Math.max(800, TIMEOUT_MS - 400)
const UPPER_MS = Math.max(15_000, TIMEOUT_MS * 8)
const DIAGNOSTIC = `remote worker did not reconnect within ${TIMEOUT_MS}ms`
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

function readState() {
  if (!STATE_PATH || !fs.existsSync(STATE_PATH)) return { runTasks: [], tasks: {} }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function taskForRun(runId) {
  const rec = (readState().runTasks ?? []).find((t) => t.runId === runId)
  if (!rec) return null
  return { arn: rec.taskArn, ...(readState().tasks?.[rec.taskArn] ?? {}) }
}

function connectBrowser(timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE)
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        // ignore
      }
      reject(new Error(`browser ws connect timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    ws.on('open', () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function waitForReconnect(timeoutMs = 45_000) {
  const start = Date.now()
  let lastErr
  while (Date.now() - start < timeoutMs) {
    try {
      return await connectBrowser(2_000)
    } catch (err) {
      lastErr = err
      await sleep(200)
    }
  }
  throw lastErr ?? new Error(`replacement server did not accept /ws within ${timeoutMs}ms`)
}

function attachRpc(ws) {
  let nextId = 1
  const pending = new Map()
  const statusWaiters = new Map()
  const statusHistory = new Map()
  const eventListeners = []

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
        for (const fn of eventListeners) fn(payload)
      }
    }
  })

  const invoke = (channel, ...args) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ type: 'invoke', id, channel, args }))
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${channel} timed out`))), 30_000)
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
      const timer = setTimeout(() => reject(new Error(`no events streamed for ${runId} within ${timeoutMs}ms`)), timeoutMs)
      eventListeners.push((payload) => {
        if (payload.runId === runId && payload.events?.length > 0) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

  return { invoke, waitStatus, waitEvents }
}

function waitForClose(ws, timeoutMs = 15_000) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws did not close after kill signal')), timeoutMs)
    ws.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function waitForPidExit(pid, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const task = Object.values(readState().tasks ?? {}).find((t) => t.pid === pid || t.workerPid === pid)
    if (!pidAlive(pid) || task?.lastStatus === 'STOPPED') {
      return Date.now() - start
    }
    await sleep(50)
  }
  throw new Error(`worker pid ${pid} still alive after ${timeoutMs}ms`)
}

let ws
try {
  ws = await connectBrowser()
  const rpc = attachRpc(ws)
  const agent = await rpc.invoke('agents:create', {
    name: `e2e-fargate-expiry-${Date.now()}`,
    runner: 'claude',
    prompt: 'E2E_LONG keep going until reconnect expiry',
    envVars: {},
    mcpConfig: { mcpServers: {} },
  })
  const run = await rpc.invoke('runs:start', agent.id)
  check('expiry: run started', run?.status === 'running' && run?.workerKind === 'fargate', `id=${run?.id}`)
  await rpc.waitEvents(run.id)

  let task = taskForRun(run.id)
  const started = Date.now()
  while ((!task?.pid || !pidAlive(task.pid)) && Date.now() - started < 10_000) {
    await sleep(50)
    task = taskForRun(run.id)
  }
  const pid = task?.pid
  check('expiry: fake ECS recorded a live worker pid', typeof pid === 'number' && pidAlive(pid), `pid=${pid}`)

  console.log(`[fargate] EXPIRY_KILL_SERVER runId=${run.id} pid=${pid}`)
  await waitForClose(ws)
  const t0 = Date.now()

  await sleep(Math.min(400, Math.max(200, TIMEOUT_MS / 3)))
  check('expiry: worker still alive before timeout', pidAlive(pid), `pid=${pid} elapsed=${Date.now() - t0}ms`)

  await waitForPidExit(pid, UPPER_MS)
  const elapsed = Date.now() - t0
  check(
    'expiry: worker retried until timeout',
    elapsed >= LOWER_MS && elapsed <= UPPER_MS,
    `elapsed=${elapsed}ms lower=${LOWER_MS} upper=${UPPER_MS}`
  )

  const after = taskForRun(run.id)
  const exitCode = after?.exitCode
  check(
    'expiry: worker exited non-zero',
    typeof exitCode === 'number' && exitCode !== 0,
    `exitCode=${exitCode} task=${JSON.stringify(after)}`
  )
  check(
    'expiry: retry timestamps recorded',
    Array.isArray(after?.retryTimestamps) && after.retryTimestamps.length >= 1,
    `retries=${JSON.stringify(after?.retryTimestamps)}`
  )

  console.log(`[fargate] EXPIRY_START_REPLACEMENT runId=${run.id} elapsed=${elapsed}ms`)
  const ws2 = await waitForReconnect()
  const rpc2 = attachRpc(ws2)
  const final = await rpc2.waitStatus(run.id, ['failed', 'completed', 'stopped'])
  check('expiry: run failed', final.status === 'failed', `status=${final.status}`)
  const log = JSON.stringify(await rpc2.invoke('runs:getLog', run.id))
  check('expiry: reconnect-timeout diagnostic', log.includes(DIAGNOSTIC), log.slice(0, 240))

  try {
    ws2.close()
  } catch {
    // ignore
  }
  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed.length} CHECK(S) FAILED`)
  process.exit(failed.length === 0 ? 0 : 1)
} catch (err) {
  console.error('E2E fargate expiry driver error:', err)
  process.exit(1)
} finally {
  try {
    ws?.close()
  } catch {
    // ignore
  }
}
