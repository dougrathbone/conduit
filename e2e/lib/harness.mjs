/**
 * Shared harness for the e2e suites: database provisioning, process lifecycle,
 * and driver execution. Used by e2e/local/run.mjs and e2e/remote/run.mjs.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const stubBinDir = path.join(repoRoot, 'e2e/lib/bin')

export const PG_BASE = (process.env.CONDUIT_E2E_PG || 'postgres://conduit:conduit@localhost:5432').replace(/\/$/, '')

/** Create the e2e database if missing (connects via the always-present `conduit` DB). */
export async function ensureDatabase(dbName) {
  const client = new pg.Client({ connectionString: `${PG_BASE}/conduit`, ssl: false })
  await client.connect()
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
  if (rows.length === 0) {
    await client.query(`CREATE DATABASE "${dbName}"`)
    console.log(`[e2e] Created database ${dbName}`)
  }
  await client.end()
}

/** Spawn a long-running process with captured output for later inspection. */
export function startProcess(name, command, args, { env = {}, cwd = repoRoot } = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (c) => (output += c))
  child.stderr.on('data', (c) => (output += c))
  return { name, child, getOutput: () => output }
}

/**
 * Resolve when `marker` appears in the process output at or after `fromOffset`
 * (default 0 — pass the current output length to wait for a *new* occurrence);
 * reject on timeout/early exit.
 */
export function waitForOutput(proc, marker, timeoutMs = 45_000, fromOffset = 0) {
  return new Promise((resolve, reject) => {
    if (proc.getOutput().indexOf(marker, fromOffset) !== -1) return resolve()
    const timer = setTimeout(() => {
      reject(new Error(`${proc.name} did not emit "${marker}" within ${timeoutMs}ms\n${proc.getOutput()}`))
    }, timeoutMs)
    const onData = () => {
      if (proc.getOutput().indexOf(marker, fromOffset) !== -1) {
        clearTimeout(timer)
        proc.child.stdout.off('data', onData)
        resolve()
      }
    }
    proc.child.stdout.on('data', onData)
    proc.child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${proc.name} exited early (code ${code})\n${proc.getOutput()}`))
    })
  })
}

/** Stop a process (SIGTERM, escalating to SIGKILL) and wait for it to exit. */
export async function stopProcess(proc) {
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) return
  proc.child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolve) => proc.child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ])
  if (!exited) {
    proc.child.kill('SIGKILL')
    await new Promise((resolve) => proc.child.once('exit', resolve))
  }
}

/** Run a driver script, streaming its stdio; resolves with its exit code. */
export function runDriver(driverPath, env = {}) {
  return new Promise((resolve) => {
    const driver = spawn('node', [driverPath], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    })
    driver.on('exit', (code) => resolve(code ?? 1))
  })
}

export function requireBuild(...entries) {
  for (const entry of entries) {
    if (!fs.existsSync(path.join(repoRoot, entry))) {
      console.error(`[e2e] ${entry} not found — run \`npm run build\` first.`)
      process.exit(1)
    }
  }
}
