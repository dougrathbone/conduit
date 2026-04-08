import { ipcMain } from 'electron'
import { listGlobalMcps, createGlobalMcp, updateGlobalMcp, deleteGlobalMcp } from '../db/queries/globalMcps'

export function registerGlobalMcpHandlers(): void {
  ipcMain.handle('globalMcps:list', () => listGlobalMcps())
  ipcMain.handle('globalMcps:create', (_, data) => createGlobalMcp(data))
  ipcMain.handle('globalMcps:update', (_, id, data) => updateGlobalMcp(id, data))
  ipcMain.handle('globalMcps:delete', (_, id) => deleteGlobalMcp(id))
}
