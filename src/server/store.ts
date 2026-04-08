/**
 * Simple JSON file-backed key-value store for server mode.
 * Replaces electron-store + safeStorage which require Electron APIs.
 *
 * The GitHub PAT is stored as plain base64 in server mode (no OS keychain
 * available in Docker). Users should treat the data volume as trusted.
 */
import * as fs from 'fs'
import * as path from 'path'
import { DB_PATH } from '../main/utils/paths'

// Store the prefs JSON file alongside the SQLite DB
const PREFS_PATH = path.join(path.dirname(DB_PATH), 'prefs.json')

type StoreData = Record<string, unknown>

function loadData(): StoreData {
  try {
    if (fs.existsSync(PREFS_PATH)) {
      return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')) as StoreData
    }
  } catch {
    // Fall through to defaults
  }
  return {}
}

function saveData(data: StoreData): void {
  fs.writeFileSync(PREFS_PATH, JSON.stringify(data, null, 2), 'utf8')
}

export function serverStoreGet<T>(key: string): T | undefined {
  const data = loadData()
  return data[key] as T | undefined
}

export function serverStoreSet(key: string, value: unknown): void {
  const data = loadData()
  data[key] = value
  saveData(data)
}

export function getGithubPat(): string | undefined {
  const encoded = serverStoreGet<string>('githubPatEncoded')
  if (!encoded) return undefined
  try {
    return Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

export function setGithubPat(pat: string): void {
  serverStoreSet('githubPatEncoded', Buffer.from(pat, 'utf8').toString('base64'))
}
