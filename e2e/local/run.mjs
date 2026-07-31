/**
 * Orchestrates the local-factory e2e test (`npm run e2e:local`):
 *   1. ensures the server build exists (npm run build first)
 *   2. ensures the e2e Postgres database exists (creates it if missing)
 *   3. starts the server with the stub `claude` CLI on PATH and a fresh
 *      CONDUIT_DATA_DIR, on a dedicated port (default 7560, away from dev's 7456)
 *   4. runs the shared driver (e2e/lib/drive.mjs) against it
 *   5. tears the server down and exits with the driver's code
 *
 * Env overrides: CONDUIT_E2E_PORT, CONDUIT_E2E_DB, CONDUIT_E2E_PG (base
 * connection string, default postgres://conduit:conduit@localhost:5432).
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

const PORT = Number(process.env.CONDUIT_E2E_PORT) || 7560
const DB_NAME = process.env.CONDUIT_E2E_DB || 'conduit_e2e'

async function main() {
  requireBuild('out/server/index.js')
  await ensureDatabase(DB_NAME)

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-e2e-local-'))
  const server = startProcess('server', 'node', [path.join(repoRoot, 'out/server/index.js')], {
    env: {
      PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
      PORT: String(PORT),
      CONDUIT_DATA_DIR: dataDir,
      DATABASE_URL: `${PG_BASE}/${DB_NAME}`,
      DATABASE_SSL: 'disable',
    },
  })

  let exitCode = 1
  try {
    await waitForOutput(server, 'running at')
    console.log(`[e2e] Server up on port ${PORT} (data dir ${dataDir})`)
    exitCode = await runDriver(path.join(repoRoot, 'e2e/lib/drive.mjs'), {
      CONDUIT_URL: `ws://localhost:${PORT}/ws`,
      CONDUIT_DATA_DIR: dataDir,
      EXPECT_WORKER_KIND: 'local',
    })
  } finally {
    await stopProcess(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  process.exit(exitCode)
}

main().catch((err) => {
  console.error('[e2e]', err.message ?? err)
  process.exit(1)
})
