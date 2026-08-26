/**
 * Fargate process-replacement restart driver.
 *
 * Starts a gated E2E_RECONNECT run, waits for RECONNECT_BEFORE, signals the
 * orchestrator to SIGKILL the server, releases DURING/AFTER gates while the
 * endpoint is down, then reconnects to the replacement and asserts:
 *   - run status completed, exit 0
 *   - each marker exactly once, in before/during/after order
 *   - matching fake ECS task STOPPED
 *
 * Env: CONDUIT_URL, CONDUIT_DATA_DIR, CONDUIT_FARGATE_E2E_STATE.
 * Orchestrator handshake: prints RESTART_KILL_SERVER after BEFORE.
 */
import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.CONDUIT_URL
const DATA_DIR = process.env.CONDUIT_DATA_DIR
const STATE_PATH = process.env.CONDUIT_FARGATE_E2E_STATE
const GATE_DIR = path.join(DATA_DIR, 'reconnect-gates')
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

function releaseGate(name) {
  fs.mkdirSync(GATE_DIR, { recursive: true })
  fs.writeFileSync(path.join(GATE_DIR, name), '1')
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
  const eventsByRun = new Map()
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

  const waitEventText = (runId, needle, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const matches = (events) => JSON.stringify(events ?? []).includes(needle)
      if (matches(eventsByRun.get(runId))) return resolve()
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${needle} on ${runId}`)),
        timeoutMs
      )
      eventListeners.push((payload) => {
        if (payload.runId === runId && matches(eventsByRun.get(runId))) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

  return { invoke, waitStatus, waitEventText, eventsByRun }
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

function countNeedle(haystack, needle) {
  if (!haystack) return 0
  return haystack.split(needle).length - 1
}

function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) return resolve()
      } catch {
        // retry
      }
      if (Date.now() - start >= timeoutMs) {
        return reject(new Error(`timed out waiting for ${label}`))
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

let ws
try {
  fs.mkdirSync(GATE_DIR, { recursive: true })
  ws = await connectBrowser()
  const rpc = attachRpc(ws)
  const agent = await rpc.invoke('agents:create', {
    name: `e2e-fargate-restart-${Date.now()}`,
    runner: 'claude',
    prompt: 'E2E_RECONNECT gated markers',
    envVars: {},
    mcpConfig: { mcpServers: {} },
  })
  const run = await rpc.invoke('runs:start', agent.id)
  check('restart: run started', run?.status === 'running' && run?.workerKind === 'fargate', `id=${run?.id}`)

  await rpc.waitEventText(run.id, 'RECONNECT_BEFORE')
  check('restart: saw RECONNECT_BEFORE', true)

  console.log(`[fargate] RESTART_KILL_SERVER runId=${run.id}`)
  await waitForClose(ws)

  releaseGate('during')
  await sleep(250)
  releaseGate('after')

  const ws2 = await waitForReconnect()
  const rpc2 = attachRpc(ws2)
  const final = await rpc2.waitStatus(run.id, ['completed', 'failed', 'stopped'])
  check('restart: run completed', final.status === 'completed', `status=${final.status} exitCode=${final.exitCode}`)

  const rows = await rpc2.invoke('runs:list', agent.id)
  const row = rows.find((r) => r.id === run.id)
  check(
    'restart: record exit 0',
    row?.status === 'completed' && row?.exitCode === 0,
    `status=${row?.status} exitCode=${row?.exitCode}`
  )

  const log = JSON.stringify(await rpc2.invoke('runs:getLog', run.id))
  const beforeCount = countNeedle(log, 'RECONNECT_BEFORE')
  const duringCount = countNeedle(log, 'RECONNECT_DURING')
  const afterCount = countNeedle(log, 'RECONNECT_AFTER')
  check('restart: RECONNECT_BEFORE exactly once', beforeCount === 1, `count=${beforeCount}`)
  check('restart: RECONNECT_DURING exactly once', duringCount === 1, `count=${duringCount}`)
  check('restart: RECONNECT_AFTER exactly once', afterCount === 1, `count=${afterCount}`)
  const beforeAt = log.indexOf('RECONNECT_BEFORE')
  const duringAt = log.indexOf('RECONNECT_DURING')
  const afterAt = log.indexOf('RECONNECT_AFTER')
  check(
    'restart: marker order before/during/after',
    beforeAt >= 0 && duringAt > beforeAt && afterAt > duringAt,
    `idx=${beforeAt},${duringAt},${afterAt}`
  )

  await waitUntil(() => {
    const rec = (readState().runTasks ?? []).find((t) => t.runId === run.id)
    if (!rec) return false
    return readState().tasks?.[rec.taskArn]?.lastStatus === 'STOPPED'
  }, 20_000, 'fake ECS task STOPPED')
  const rec = (readState().runTasks ?? []).find((t) => t.runId === run.id)
  const task = rec ? readState().tasks?.[rec.taskArn] : null
  check('restart: matching fake ECS task STOPPED', task?.lastStatus === 'STOPPED', JSON.stringify(task))

  try {
    ws2.close()
  } catch {
    // ignore
  }
  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed.length} CHECK(S) FAILED`)
  process.exit(failed.length === 0 ? 0 : 1)
} catch (err) {
  console.error('E2E fargate restart driver error:', err)
  process.exit(1)
} finally {
  try {
    ws?.close()
  } catch {
    // ignore
  }
}
