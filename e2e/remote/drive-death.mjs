/**
 * Worker-death scenario for the remote-factory e2e suite:
 *   1. start a long-running run on the connected worker
 *   2. SIGKILL the worker process mid-run (PID via CONDUIT_E2E_WORKER_PID)
 *   3. the server must detect the dead control-plane socket and synthesize a
 *      failed exit — the run must NOT be stuck in 'running', and the run log
 *      must carry the synthesized system line
 *
 * Env: CONDUIT_URL, CONDUIT_E2E_WORKER_PID. Launched by e2e/remote/run.mjs.
 */
import WebSocket from 'ws'

const BASE = process.env.CONDUIT_URL
const WORKER_PID = Number(process.env.CONDUIT_E2E_WORKER_PID)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

if (!WORKER_PID) {
  console.error('CONDUIT_E2E_WORKER_PID is required')
  process.exit(1)
}

const ws = new WebSocket(BASE)
await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)))

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
    if (msg.channel === 'run:statusChange') {
      const h = statusHistory.get(msg.payload.runId) ?? []
      h.push(msg.payload)
      statusHistory.set(msg.payload.runId, h)
      statusWaiters.get(msg.payload.runId)?.(msg.payload)
    }
    if (msg.channel === 'run:events') {
      for (const fn of eventListeners) fn(msg.payload)
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
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${statuses.join('/')} on ${runId}`)), timeoutMs)
    statusWaiters.set(runId, (payload) => {
      if (statuses.includes(payload.status)) {
        clearTimeout(timer)
        statusWaiters.delete(runId)
        resolve(payload)
      }
    })
  })
}

try {
  const agent = await invoke('agents:create', {
    name: 'e2e-remote-worker-death',
    runner: 'claude',
    prompt: 'E2E_LONG run until the worker dies',
    envVars: {},
    mcpConfig: { mcpServers: {} },
  })
  const run = await invoke('runs:start', agent.id)
  check('long run started on remote worker', run?.status === 'running' && run?.workerKind === 'remote', `id=${run?.id}`)

  // Execution is live on the worker once events stream.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no events streamed within 30s')), 30000)
    eventListeners.push((payload) => {
      if (payload.runId === run.id && payload.events?.length > 0) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  process.kill(WORKER_PID, 'SIGKILL')
  console.log(`[death] Sent SIGKILL to worker pid ${WORKER_PID}`)

  const final = await waitStatus(run.id, ['failed'])
  check('run failed (not stuck running) after worker death', final.status === 'failed', `status=${final.status}`)

  const [runRow] = await invoke('runs:list', agent.id)
  check('run record marked failed', runRow?.status === 'failed', `status=${runRow?.status} workerId=${runRow?.workerId}`)

  const log = await invoke('runs:getLog', run.id)
  const logText = JSON.stringify(log)
  check(
    'log records the synthesized worker-death failure',
    logText.includes('failing this run'),
    logText.includes('failing this run') ? '' : logText.slice(0, 200)
  )

  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed.length} CHECK(S) FAILED`)
  process.exitCode = failed.length === 0 ? 0 : 1
} catch (err) {
  console.error('E2E death driver error:', err)
  process.exitCode = 1
} finally {
  ws.close()
}
