import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { listRuns } from '../db/queries/runs'
import { startRun, stopRun } from '../execution/runner'
import { LOGS_DIR } from '../utils/paths'
import type { ExecutionRun, LogEntry } from '../../shared/types'

export function registerRunHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('runs:list', async (_event, agentId: string): Promise<ExecutionRun[]> => {
    return listRuns(agentId)
  })

  ipcMain.handle('runs:start', async (_event, agentId: string): Promise<ExecutionRun> => {
    return startRun(agentId, mainWindow)
  })

  ipcMain.handle('runs:stop', async (_event, runId: string): Promise<void> => {
    return stopRun(runId)
  })

  ipcMain.handle('runs:getLog', async (_event, runId: string): Promise<LogEntry[]> => {
    const logFilePath = path.join(LOGS_DIR, `${runId}.jsonl`)

    if (!fs.existsSync(logFilePath)) {
      return []
    }

    const raw = fs.readFileSync(logFilePath, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)

    const entries: LogEntry[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as LogEntry
        entries.push(entry)
      } catch {
        // Skip malformed JSONL lines
      }
    }

    return entries
  })
}
