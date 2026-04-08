import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Detect whether we are running inside an Electron process.
// In Electron, process.versions.electron is set; in plain Node it is not.
const isElectron =
  typeof process !== 'undefined' &&
  process.versions != null &&
  process.versions.electron != null

function resolveDataDir(): string {
  // 1. Explicit override via env var (used in Docker / server mode)
  if (process.env.CONDUIT_DATA_DIR) {
    return process.env.CONDUIT_DATA_DIR
  }
  // 2. Electron userData path
  if (isElectron) {
    // Dynamic require — kept as `unknown` so this file compiles cleanly
    // in both Electron and plain-Node (server) TypeScript projects.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
    const electronModule = require('electron') as any
    return (electronModule.app as { getPath(name: string): string }).getPath('userData')
  }
  // 3. Fallback for plain Node (e.g. dev server run outside Docker)
  return path.join(os.homedir(), '.conduit')
}

const dataDir = resolveDataDir()

export const DB_PATH: string = path.join(dataDir, 'conduit.db')
export const LOGS_DIR: string = path.join(dataDir, 'logs')
export const WORKSPACES_BASE: string = os.tmpdir()

// Ensure LOGS_DIR exists on module import
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true })
}
