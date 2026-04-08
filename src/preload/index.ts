import { contextBridge, ipcRenderer } from 'electron'
import type { ConduitAPI, RunOutputPayload, RunStatusChangePayload, OAuthToken, RunnerType } from '../shared/types'

const api: ConduitAPI = {
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    get: (id) => ipcRenderer.invoke('agents:get', id),
    create: (data) => ipcRenderer.invoke('agents:create', data),
    update: (id, data) => ipcRenderer.invoke('agents:update', id, data),
    delete: (id) => ipcRenderer.invoke('agents:delete', id),
  },

  runs: {
    list: (agentId) => ipcRenderer.invoke('runs:list', agentId),
    start: (agentId) => ipcRenderer.invoke('runs:start', agentId),
    stop: (runId) => ipcRenderer.invoke('runs:stop', runId),
    getLog: (runId) => ipcRenderer.invoke('runs:getLog', runId),
  },

  onOutput: (cb: (payload: RunOutputPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RunOutputPayload) => cb(payload)
    ipcRenderer.on('run:output', handler)
    return () => ipcRenderer.off('run:output', handler)
  },

  onRunStatusChange: (cb: (payload: RunStatusChangePayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RunStatusChangePayload) =>
      cb(payload)
    ipcRenderer.on('run:statusChange', handler)
    return () => ipcRenderer.off('run:statusChange', handler)
  },

  gist: {
    save: (content, gistId) => ipcRenderer.invoke('gist:save', content, gistId),
    load: (gistId) => ipcRenderer.invoke('gist:load', gistId),
  },

  prefs: {
    get: (key) => ipcRenderer.invoke('prefs:get', key),
    set: (key, value) => ipcRenderer.invoke('prefs:set', key, value),
  },

  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },

  globalMcps: {
    list: () => ipcRenderer.invoke('globalMcps:list'),
    create: (data) => ipcRenderer.invoke('globalMcps:create', data),
    update: (id, data) => ipcRenderer.invoke('globalMcps:update', id, data),
    delete: (id) => ipcRenderer.invoke('globalMcps:delete', id),
  },

  mcpOAuth: {
    getToken: (serverUrl: string): Promise<OAuthToken | null> =>
      ipcRenderer.invoke('mcp:oauth:getToken', serverUrl),
    startAuth: (serverId: string, isGlobal: boolean): Promise<void> =>
      ipcRenderer.invoke('mcp:oauth:startAuth', serverId, isGlobal),
    revokeToken: (serverUrl: string): Promise<void> =>
      ipcRenderer.invoke('mcp:oauth:revokeToken', serverUrl),
  },

  onMcpOAuthComplete: (
    cb: (payload: { serverUrl: string; success: boolean; error?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { serverUrl: string; success: boolean; error?: string }
    ) => cb(payload)
    ipcRenderer.on('mcp:oauth:complete', handler)
    return () => ipcRenderer.removeListener('mcp:oauth:complete', handler)
  },

  promptChat: {
    start: (agentId: string, runner: RunnerType): Promise<string> =>
      ipcRenderer.invoke('promptChat:start', agentId, runner),
    send: (sessionId: string, message: string): Promise<void> =>
      ipcRenderer.invoke('promptChat:send', sessionId, message),
    close: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke('promptChat:close', sessionId),
  },

  onPromptChatToken: (
    cb: (payload: { sessionId: string; token: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { sessionId: string; token: string }
    ) => cb(payload)
    ipcRenderer.on('promptChat:token', handler)
    return () => ipcRenderer.removeListener('promptChat:token', handler)
  },

  onPromptChatDone: (
    cb: (payload: { sessionId: string; extractedPrompt?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { sessionId: string; extractedPrompt?: string }
    ) => cb(payload)
    ipcRenderer.on('promptChat:done', handler)
    return () => ipcRenderer.removeListener('promptChat:done', handler)
  },

  onPromptChatError: (
    cb: (payload: { sessionId: string; error: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { sessionId: string; error: string }
    ) => cb(payload)
    ipcRenderer.on('promptChat:error', handler)
    return () => ipcRenderer.removeListener('promptChat:error', handler)
  },
}

contextBridge.exposeInMainWorld('conduit', api)
