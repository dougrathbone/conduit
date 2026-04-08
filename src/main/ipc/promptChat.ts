import { ipcMain, BrowserWindow } from 'electron'
import { createSession, sendMessage, closeSession } from '../services/promptChat'
import type { RunnerType } from '../../shared/types'

export function registerPromptChatHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('promptChat:start', (_event, agentId: string, runner: RunnerType) =>
    createSession(agentId, runner)
  )

  ipcMain.handle('promptChat:send', async (_event, sessionId: string, message: string) => {
    await sendMessage(sessionId, message, mainWindow)
  })

  ipcMain.handle('promptChat:close', (_event, sessionId: string) => {
    closeSession(sessionId)
  })
}
