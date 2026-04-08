import { ipcMain } from 'electron'
import { listAgents, getAgent, createAgent, updateAgent, deleteAgent } from '../db/queries/agents'
import type { AgentConfig } from '../../shared/types'

export function registerAgentHandlers(): void {
  ipcMain.handle('agents:list', async (): Promise<AgentConfig[]> => {
    return listAgents()
  })

  ipcMain.handle('agents:get', async (_event, id: string): Promise<AgentConfig | null> => {
    return getAgent(id)
  })

  ipcMain.handle(
    'agents:create',
    async (
      _event,
      data: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>
    ): Promise<AgentConfig> => {
      return createAgent(data)
    }
  )

  ipcMain.handle(
    'agents:update',
    async (
      _event,
      id: string,
      data: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>
    ): Promise<AgentConfig> => {
      return updateAgent(id, data)
    }
  )

  ipcMain.handle('agents:delete', async (_event, id: string): Promise<void> => {
    deleteAgent(id)
  })
}
