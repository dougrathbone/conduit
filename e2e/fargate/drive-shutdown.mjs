/**
 * Start a long-running Fargate e2e run and leave it live so the orchestrator
 * can SIGTERM the server and assert factory shutdown StopTasks everything.
 *
 * Env: CONDUIT_URL. Launched by e2e/fargate/run.mjs.
 */
import WebSocket from 'ws'

const BASE = process.env.CONDUIT_URL
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const ws = new WebSocket(BASE)
await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)))

let nextId = 1
const pending = new Map()
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
  } else if (msg.type === 'event' && msg.channel === 'run:events') {
    for (const fn of eventListeners) fn(msg.payload)
  }
})

const invoke = (channel, ...args) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ type: 'invoke', id, channel, args }))
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${channel} timed out`))), 30000)
  })

try {
  const agent = await invoke('agents:create', {
    name: 'e2e-fargate-shutdown',
    runner: 'claude',
    prompt: 'E2E_LONG keep going until the server shuts down',
    envVars: {},
    mcpConfig: { mcpServers: {} },
  })
  const run = await invoke('runs:start', agent.id)
  check('shutdown-prep: long run started', run?.status === 'running' && run?.workerKind === 'fargate', `id=${run?.id}`)

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no events streamed within 30s')), 30000)
    eventListeners.push((payload) => {
      if (payload.runId === run.id && payload.events?.length > 0) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  check('shutdown-prep: execution is live', true, `runId=${run.id}`)
  console.log(`[fargate] SHUTDOWN_PREP_READY runId=${run.id}`)

  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed.length} CHECK(S) FAILED`)
  process.exitCode = failed.length === 0 ? 0 : 1
} catch (err) {
  console.error('E2E fargate shutdown-prep error:', err)
  process.exitCode = 1
} finally {
  ws.close()
}
