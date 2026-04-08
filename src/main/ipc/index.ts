import { ipcMain, BrowserWindow } from 'electron'
import { registerAgentHandlers } from './agents'
import { registerRunHandlers } from './runs'
import { registerGistHandlers } from './gist'
import { registerGlobalMcpHandlers } from './globalMcps'
import { registerMcpOAuthHandlers } from './mcpOAuth'
import { registerPromptChatHandlers } from './promptChat'
import { store, getGithubPat, setGithubPat } from '../store/index'

export function registerAllHandlers(mainWindow: BrowserWindow): void {
  registerAgentHandlers()
  registerRunHandlers(mainWindow)
  registerGistHandlers()
  registerGlobalMcpHandlers()
  registerMcpOAuthHandlers(mainWindow)
  registerPromptChatHandlers(mainWindow)

  // prefs:get — retrieve a value from electron-store
  ipcMain.handle('prefs:get', async (_event, key: string): Promise<unknown> => {
    // Special handling for githubPat — use safeStorage decryption
    if (key === 'githubPat') {
      return getGithubPat()
    }
    return store.get(key as never)
  })

  // prefs:set — store a value in electron-store
  ipcMain.handle('prefs:set', async (_event, key: string, value: unknown): Promise<void> => {
    // Special handling for githubPat — use safeStorage encryption
    if (key === 'githubPat') {
      if (typeof value === 'string') {
        setGithubPat(value)
      }
      return
    }
    store.set(key as never, value as never)
  })
}
