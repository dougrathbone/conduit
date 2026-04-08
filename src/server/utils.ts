import * as fs from 'fs'
import * as path from 'path'
import { LOGS_DIR } from '../main/utils/paths'
import type { LogEntry } from '../shared/types'

/**
 * Read a JSONL log file for a run and return parsed log entries.
 * Returns an empty array if the file does not exist or is empty.
 */
export function readLogFile(runId: string): LogEntry[] {
  const logPath = path.join(LOGS_DIR, `${runId}.jsonl`)
  if (!fs.existsSync(logPath)) return []

  const raw = fs.readFileSync(logPath, 'utf8')
  const entries: LogEntry[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as LogEntry)
    } catch {
      // Skip malformed JSONL lines
    }
  }

  return entries
}
