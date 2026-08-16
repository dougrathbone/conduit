/**
 * Orchestrates the simulated-Fargate e2e test (`npm run e2e:fargate`):
 *
 *   server (CONDUIT_WORKER_FACTORY=fargate + fake ECS)  <──WSS Bearer──  spawned workers
 *
 * The fake ECS (e2e/fargate/fakeEcs.cjs) is injected via CONDUIT_FARGATE_E2E_FAKE_ECS
 * and launches real `node out/worker/index.js` processes. No AWS account is used.
 *
 * Phases:
 *   1. drive.mjs — completion, failure, cancel, connect timeout, crash,
 *      parallel agents, same-agent rejection, cleanup/secret/ARN asserts
 *   2. drive-shutdown.mjs — leave a long run live, then SIGTERM the server
 *      and assert every simulated task is STOPPED
 *
 * Env overrides: CONDUIT_E2E_PORT (default 7562), CONDUIT_E2E_DB (default
 * conduit_e2e_fargate), CONDUIT_E2E_PG. Postgres must be reachable — see
 * `npm run db:up`.
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

const PORT = Number(process.env.CONDUIT_E2E_PORT) || 7562
const DB_NAME = process.env.CONDUIT_E2E_DB || 'conduit_e2e_fargate'
const TOKEN = 'e2e-worker-token'
const SERVER_URL = `ws://localhost:${PORT}/ws/worker`

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) return { runTasks: [], tasks: {} }
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
}

function runningCount(state) {
  return Object.values(state.tasks ?? {}).filter((t) => t.lastStatus === 'RUNNING').length
}

async function main() {
  requireBuild('out/server/index.js', 'out/worker/index.js')
  await ensureDatabase(DB_NAME)

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-e2e-fargate-'))
  const stateFile = path.join(dataDir, 'fake-ecs.json')
  const skipSpawn = path.join(dataDir, 'skip-spawn')
  const fakeEcs = path.join(repoRoot, 'e2e/fargate/fakeEcs.cjs')

  const server = startProcess('server', 'node', [path.join(repoRoot, 'out/server/index.js')], {
    env: {
      PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
      PORT: String(PORT),
      CONDUIT_DATA_DIR: dataDir,
      DATABASE_URL: `${PG_BASE}/${DB_NAME}`,
      DATABASE_SSL: 'disable',
      CONDUIT_WORKER_FACTORY: 'fargate',
      CONDUIT_WORKER_TOKEN: TOKEN,
      CONDUIT_SERVER_URL: SERVER_URL,
      CONDUIT_FARGATE_CLUSTER: 'conduit-e2e',
      CONDUIT_FARGATE_TASK_DEFINITION: 'conduit-worker:e2e',
      CONDUIT_FARGATE_SUBNETS: 'subnet-e2e0001,subnet-e2e0002',
      CONDUIT_E2E: '1',
      CONDUIT_FARGATE_E2E_FAKE_ECS: fakeEcs,
      CONDUIT_FARGATE_E2E_STATE: stateFile,
      CONDUIT_FARGATE_E2E_SKIP_SPAWN: skipSpawn,
      CONDUIT_FARGATE_E2E_WORKER_BIN: path.join(repoRoot, 'out/worker/index.js'),
      CONDUIT_WORKER_CONNECT_TIMEOUT_MS: '4000',
    },
  })

  const driverEnv = {
    CONDUIT_URL: `ws://localhost:${PORT}/ws`,
    CONDUIT_DATA_DIR: dataDir,
    CONDUIT_FARGATE_E2E_STATE: stateFile,
    CONDUIT_FARGATE_E2E_SKIP_SPAWN: skipSpawn,
    CONDUIT_E2E_TOKEN: TOKEN,
    EXPECT_WORKER_KIND: 'fargate',
  }

  let exitCode
  let shutdownPrepared = false
  try {
    await waitForOutput(server, 'running at')
    console.log(`[e2e] Server up on port ${PORT} (fargate factory + fake ECS, data dir ${dataDir})`)

    console.log('[e2e] Running fargate driver suite')
    exitCode = await runDriver(path.join(repoRoot, 'e2e/fargate/drive.mjs'), driverEnv)
    if (exitCode !== 0) throw new Error('fargate driver suite failed')

    console.log('[e2e] Running server-shutdown cleanup scenario')
    exitCode = await runDriver(path.join(repoRoot, 'e2e/fargate/drive-shutdown.mjs'), driverEnv)
    if (exitCode !== 0) throw new Error('shutdown-prep failed')

    const beforeStop = readState(stateFile)
    const liveBefore = runningCount(beforeStop)
    if (liveBefore < 1) {
      throw new Error(`expected a live simulated task before server shutdown, found ${liveBefore}`)
    }
    console.log(`[e2e] ${liveBefore} simulated task(s) running — SIGTERM server`)
    shutdownPrepared = true
  } finally {
    await stopProcess(server)
  }

  if (shutdownPrepared) {
    const after = readState(stateFile)
    const liveAfter = runningCount(after)
    if (liveAfter !== 0) {
      console.error(`[e2e] FAIL  shutdown: simulated tasks still running (${liveAfter})`)
      console.error(JSON.stringify(after, null, 2))
      fs.rmSync(dataDir, { recursive: true, force: true })
      process.exit(1)
    }
    console.log('[e2e] PASS  shutdown: every started task stopped')
  }
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(exitCode ?? 1)
}

main().catch((err) => {
  console.error('[e2e]', err.message ?? err)
  process.exit(1)
})
