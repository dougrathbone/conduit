/**
 * Orchestrates the remote-factory e2e test (`npm run e2e:remote`) — the
 * decoupled execution path:
 *
 *   server (CONDUIT_WORKER_FACTORY=remote)  <──WSS Bearer──  conduit-worker
 *
 * Phases:
 *   1. full driver suite against worker 1 (assign/stream/stop/concurrency
 *      over the control plane, workerKind=remote, workerId recorded)
 *   2. drive-death.mjs: SIGKILL worker 1 mid-run — the server must detect the
 *      dead socket and fail the run (lease semantics, no stuck 'running')
 *   3. connect worker 2 and re-run the driver in quick mode — proves the
 *      control plane recovers and accepts new workers
 *
 * Env overrides: CONDUIT_E2E_PORT (default 7561), CONDUIT_E2E_DB (default
 * conduit_e2e_remote), CONDUIT_E2E_PG (base connection string).
 * Postgres must be reachable — see `npm run db:up`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  repoRoot,
  stubBinDir,
  PG_BASE,
  ensureDatabase,
  requireBuild,
  startProcess,
  waitForOutput,
  stopProcess,
  runDriver,
} from '../lib/harness.mjs'

const PORT = Number(process.env.CONDUIT_E2E_PORT) || 7561
const DB_NAME = process.env.CONDUIT_E2E_DB || 'conduit_e2e_remote'
const TOKEN = 'e2e-worker-token'
const SERVER_URL = `ws://localhost:${PORT}/ws/worker`

function startWorker() {
  return startProcess('worker', 'node', [path.join(repoRoot, 'out/worker/index.js')], {
    env: {
      PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
      CONDUIT_SERVER_URL: SERVER_URL,
      CONDUIT_WORKER_TOKEN: TOKEN,
    },
  })
}

async function main() {
  requireBuild('out/server/index.js', 'out/worker/index.js')
  await ensureDatabase(DB_NAME)

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-e2e-remote-'))
  const server = startProcess('server', 'node', [path.join(repoRoot, 'out/server/index.js')], {
    env: {
      PORT: String(PORT),
      CONDUIT_DATA_DIR: dataDir,
      DATABASE_URL: `${PG_BASE}/${DB_NAME}`,
      DATABASE_SSL: 'disable',
      CONDUIT_WORKER_FACTORY: 'remote',
      CONDUIT_WORKER_TOKEN: TOKEN,
    },
  })

  const driverEnv = {
    CONDUIT_URL: `ws://localhost:${PORT}/ws`,
    CONDUIT_DATA_DIR: dataDir,
    EXPECT_WORKER_KIND: 'remote',
  }
  const drivePath = path.join(repoRoot, 'e2e/lib/drive.mjs')
  let worker1
  let worker2
  let exitCode

  try {
    await waitForOutput(server, 'running at')
    console.log(`[e2e] Server up on port ${PORT} (remote factory, data dir ${dataDir})`)

    // ── Phase 1: full suite over the control plane ──
    worker1 = startWorker()
    await waitForOutput(server, 'Worker connected')
    console.log('[e2e] Worker 1 connected — running full driver suite')
    exitCode = await runDriver(drivePath, driverEnv)
    if (exitCode !== 0) throw new Error('full driver suite failed')

    // ── Phase 2: worker death mid-run ──
    console.log('[e2e] Running worker-death scenario (SIGKILL mid-run)')
    exitCode = await runDriver(path.join(repoRoot, 'e2e/remote/drive-death.mjs'), {
      ...driverEnv,
      CONDUIT_E2E_WORKER_PID: String(worker1.child.pid),
    })
    if (exitCode !== 0) throw new Error('worker-death scenario failed')

    // ── Phase 3: a fresh worker connects and takes runs ──
    const offset = server.getOutput().length
    worker2 = startWorker()
    await waitForOutput(server, 'Worker connected', 45_000, offset)
    console.log('[e2e] Worker 2 connected — running quick reconnect smoke')
    exitCode = await runDriver(drivePath, { ...driverEnv, E2E_MODE: 'quick' })
  } finally {
    if (worker1) await stopProcess(worker1)
    if (worker2) await stopProcess(worker2)
    await stopProcess(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  process.exit(exitCode ?? 1)
}

main().catch((err) => {
  console.error('[e2e]', err.message ?? err)
  process.exit(1)
})
