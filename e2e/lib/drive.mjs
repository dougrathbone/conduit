/**
 * E2E driver for a running Conduit server — exercises the worker-factory path
 * over the browser /ws JSON-RPC endpoint and asserts:
 *   1. a run completes with exit 0 and correct run-record fields (workerKind)
 *   2. the log is persisted to CONDUIT_DATA_DIR/logs with parsed events
 *   3. a long-running run streams events and stops cleanly via runs:stop
 *   4. the DB-backed one-active-run-per-agent guard rejects concurrent starts
 *
 * Env:
 *   CONDUIT_URL         ws URL (default ws://localhost:7560/ws)
 *   CONDUIT_DATA_DIR    server's data dir (required for the on-disk log check)
 *   EXPECT_WORKER_KIND  expected run.workerKind — 'local' (default) or 'remote'
 *   E2E_MODE            'full' (default) or 'quick' (sections 1-3 only — used
 *                       for the remote suite's post-reconnect smoke pass)
 *
 * Normally launched via `npm run e2e:local` / `npm run e2e:remote`.
 */
import WebSocket from 'ws'
import fs from 'node:fs'

const BASE = process.env.CONDUIT_URL ?? 'ws://localhost:7560/ws'
const DATA_DIR = process.env.CONDUIT_DATA_DIR
const WORKER_KIND = process.env.EXPECT_WORKER_KIND ?? 'local'
const QUICK = process.env.E2E_MODE === 'quick'
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
// Status broadcasts can land before a waiter registers (e.g. a fast SIGTERM
// finalizes before the runs:stop RPC response returns), so keep history.
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
      const w = statusWaiters.get(msg.payload.runId)
      if (w) w(msg.payload)
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

const waitStatus = (runId, statuses, timeoutMs = 90000) => {
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

try {
  // ── 1. Create a repo-less agent (ephemeral workspace, in-process factory) ──
  const agent = await invoke('agents:create', {
    name: 'e2e-local-factory',
    runner: 'claude',
    prompt: 'Say hello from the local factory e2e test',
    envVars: {},
    mcpConfig: { mcpServers: {} },
  })
  check('agent created', !!agent?.id, `id=${agent?.id}`)

  // ── 2. Run it to completion ──
  const run = await invoke('runs:start', agent.id)
  check('run started', run?.status === 'running' || run?.status === 'launched', `id=${run?.id} status=${run?.status} workerKind=${run?.workerKind}`)
  check(`run tagged with ${WORKER_KIND} worker kind`, run?.workerKind === WORKER_KIND, `workerKind=${run?.workerKind}`)

  const final = await waitStatus(run.id, ['completed', 'failed'])
  check('run completed', final.status === 'completed', `status=${final.status} exitCode=${final.exitCode}`)

  // ── 3. Verify the persisted run record + log ──
  const [runRow] = await invoke('runs:list', agent.id)
  check('run record: status/exitCode', runRow?.status === 'completed' && runRow?.exitCode === 0, `status=${runRow?.status} exitCode=${runRow?.exitCode}`)
  check(`run record: workerKind=${WORKER_KIND} + duration`, runRow?.workerKind === WORKER_KIND && runRow?.durationMs > 0, `workerKind=${runRow?.workerKind} durationMs=${runRow?.durationMs}`)

  const log = await invoke('runs:getLog', run.id)
  const logText = JSON.stringify(log)
  const logCount = Array.isArray(log) ? log.length : (log?.events?.length ?? '?')
  check('log contains assistant output', logText.includes('stub-claude received prompt'), `${logCount} entries`)
  check('log contains result event', logText.includes('"result"') || logText.includes('Completed'))

  const logFile = `${DATA_DIR}/logs/${run.id}.jsonl`
  check('log file persisted on disk', fs.existsSync(logFile) && fs.statSync(logFile).size > 0, logFile)

  if (WORKER_KIND === 'remote') {
    check('run record carries the executing workerId', typeof runRow?.workerId === 'string' && runRow.workerId.length > 0, `workerId=${runRow?.workerId}`)
  }

  if (!QUICK) {
    // ── 4. Long-running run: stream events, then stop ──
    await invoke('agents:update', agent.id, { prompt: 'E2E_LONG keep going until stopped' })
    const run2 = await invoke('runs:start', agent.id)
    const streamed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no events streamed within 30s')), 30000)
      eventListeners.push((payload) => {
        if (payload.runId === run2.id && payload.events?.length > 0) {
          clearTimeout(timer)
          resolve(payload.events)
        }
      })
    })
    check('long run streams events live', streamed.length > 0, `${streamed.length} event(s) in first batch`)

    await invoke('runs:stop', run2.id)
    const stopped = await waitStatus(run2.id, ['stopped', 'failed'])
    check('run stops on request', stopped.status === 'stopped', `status=${stopped.status}`)

    const [run2Row] = (await invoke('runs:list', agent.id)).filter((r) => r.id === run2.id)
    check('stopped run recorded correctly', run2Row?.status === 'stopped', `status=${run2Row?.status}`)

    // ── 5. Concurrency guard: one active run per agent (DB-backed) ──
    const run3 = await invoke('runs:start', agent.id)
    let rejected = false
    try {
      await invoke('runs:start', agent.id)
    } catch (e) {
      rejected = /already/i.test(e.message)
    }
    check('second concurrent run rejected', rejected)
    await invoke('runs:stop', run3.id)
    await waitStatus(run3.id, ['stopped', 'failed'])
  }

  const failed = results.filter((r) => !r.ok)
  const suffix = QUICK ? ' (quick)' : ''
  console.log(failed.length === 0 ? `\nALL ${results.length} CHECKS PASSED${suffix}` : `\n${failed.length} CHECK(S) FAILED`)
  process.exitCode = failed.length === 0 ? 0 : 1
} catch (err) {
  console.error('E2E driver error:', err)
  process.exitCode = 1
} finally {
  ws.close()
}
