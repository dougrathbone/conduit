/**
 * Orchestrates the local-factory e2e test (`npm run e2e:local`):
 *   1. ensures the server build exists (npm run build first)
 *   2. ensures the e2e Postgres database exists (creates it if missing)
 *   3. starts the server with the stub `claude` CLI on PATH and a fresh
 *      CONDUIT_DATA_DIR, on a dedicated port (default 7560, away from dev's 7456)
 *   4. runs the driver (drive.mjs) against it
 *   5. tears the server down and exits with the driver's code
 *
 * Env overrides: CONDUIT_E2E_PORT, CONDUIT_E2E_DB, CONDUIT_E2E_PG (base
 * connection string, default postgres://conduit:conduit@localhost:5432).
 * Postgres must be reachable — see `npm run db:up`.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')

const PORT = Number(process.env.CONDUIT_E2E_PORT) || 7560
const DB_NAME = process.env.CONDUIT_E2E_DB || 'conduit_e2e'
const PG_BASE = (process.env.CONDUIT_E2E_PG || 'postgres://conduit:conduit@localhost:5432').replace(/\/$/, '')

async function ensureDatabase() {
  // Connect to the always-present `conduit` maintenance DB to create the e2e DB.
  const client = new pg.Client({ connectionString: `${PG_BASE}/conduit`, ssl: false })
  await client.connect()
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME])
  if (rows.length === 0) {
    await client.query(`CREATE DATABASE "${DB_NAME}"`)
    console.log(`[e2e] Created database ${DB_NAME}`)
  }
  await client.end()
}

function waitForServer(child, getOutput, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not start within ${timeoutMs}ms\n${getOutput()}`))
    }, timeoutMs)
    child.stdout.on('data', function onData(chunk) {
      if (chunk.toString().includes('running at')) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolve()
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited early (code ${code})\n${getOutput()}`))
    })
  })
}

async function main() {
  const serverEntry = path.join(repoRoot, 'out/server/index.js')
  if (!fs.existsSync(serverEntry)) {
    console.error('[e2e] out/server/index.js not found — run `npm run build` first.')
    process.exit(1)
  }

  await ensureDatabase()

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-e2e-local-'))
  let serverOutput = ''
  const server = spawn('node', [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${path.join(here, 'bin')}${path.delimiter}${process.env.PATH}`,
      PORT: String(PORT),
      CONDUIT_DATA_DIR: dataDir,
      DATABASE_URL: `${PG_BASE}/${DB_NAME}`,
      DATABASE_SSL: 'disable',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (c) => (serverOutput += c))
  server.stderr.on('data', (c) => (serverOutput += c))

  let exitCode = 1
  try {
    await waitForServer(server, () => serverOutput)
    console.log(`[e2e] Server up on port ${PORT} (data dir ${dataDir})`)

    const driver = spawn('node', [path.join(here, 'drive.mjs')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CONDUIT_URL: `ws://localhost:${PORT}/ws`,
        CONDUIT_DATA_DIR: dataDir,
      },
      stdio: 'inherit',
    })
    exitCode = await new Promise((resolve) => driver.on('exit', resolve))
  } finally {
    server.kill('SIGTERM')
    await new Promise((resolve) => server.on('exit', resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  process.exit(exitCode)
}

main().catch((err) => {
  console.error('[e2e]', err.message ?? err)
  process.exit(1)
})
