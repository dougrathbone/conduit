import type {
  ConduitAPI,
  RunOutputPayload,
  RunStatusChangePayload,
  AgentConfig,
  ExecutionRun,
  LogEntry,
  GlobalMcpServer,
  PublishTarget,
  OAuthToken,
  RunnerType,
  SlackPublishConfig,
} from '@shared/types'

/**
 * Creates a ConduitAPI implementation backed by a WebSocket connection to the
 * Conduit server. This is used when running in browser/Docker mode where
 * window.conduit is not pre-populated by the Electron preload script.
 */
export function createWsConduitClient(wsUrl: string): ConduitAPI {
  const ws = new WebSocket(wsUrl)
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const outputListeners = new Set<(p: RunOutputPayload) => void>()
  const statusListeners = new Set<(p: RunStatusChangePayload) => void>()
  const oauthCompleteListeners = new Set<(p: { serverUrl: string; success: boolean; error?: string }) => void>()
  const promptTokenListeners = new Set<(p: { sessionId: string; token: string }) => void>()
  const promptDoneListeners = new Set<(p: { sessionId: string; extractedPrompt?: string }) => void>()
  const promptErrorListeners = new Set<(p: { sessionId: string; error: string }) => void>()
  let idCounter = 0

  ws.onmessage = (event) => {
    let msg: {
      type: 'response' | 'error' | 'event'
      id?: string
      result?: unknown
      error?: string
      channel?: string
      payload?: unknown
    }
    try {
      msg = JSON.parse(event.data as string)
    } catch {
      return
    }

    if (msg.type === 'response' || msg.type === 'error') {
      if (!msg.id) return
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.type === 'error') {
        p.reject(new Error(msg.error ?? 'Unknown server error'))
      } else {
        p.resolve(msg.result)
      }
    } else if (msg.type === 'event') {
      if (msg.channel === 'run:output') {
        outputListeners.forEach((cb) => cb(msg.payload as RunOutputPayload))
      } else if (msg.channel === 'run:statusChange') {
        statusListeners.forEach((cb) => cb(msg.payload as RunStatusChangePayload))
      } else if (msg.channel === 'mcp:oauth:complete') {
        oauthCompleteListeners.forEach((cb) =>
          cb(msg.payload as { serverUrl: string; success: boolean; error?: string })
        )
      } else if (msg.channel === 'promptChat:token') {
        promptTokenListeners.forEach((cb) =>
          cb(msg.payload as { sessionId: string; token: string })
        )
      } else if (msg.channel === 'promptChat:done') {
        promptDoneListeners.forEach((cb) =>
          cb(msg.payload as { sessionId: string; extractedPrompt?: string })
        )
      } else if (msg.channel === 'promptChat:error') {
        promptErrorListeners.forEach((cb) =>
          cb(msg.payload as { sessionId: string; error: string })
        )
      }
    }
  }

  function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = String(idCounter++)
      pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      })

      const send = () =>
        ws.send(JSON.stringify({ type: 'invoke', id, channel, args }))

      if (ws.readyState === WebSocket.OPEN) {
        send()
      } else {
        ws.addEventListener('open', send, { once: true })
      }
    })
  }

  return {
    agents: {
      list: () => invoke<AgentConfig[]>('agents:list'),
      get: (id: string) => invoke<AgentConfig | null>('agents:get', id),
      create: (data: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>) =>
        invoke<AgentConfig>('agents:create', data),
      update: (
        id: string,
        data: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>
      ) => invoke<AgentConfig>('agents:update', id, data),
      delete: (id: string) => invoke<void>('agents:delete', id),
    },

    runs: {
      list: (agentId: string) => invoke<ExecutionRun[]>('runs:list', agentId),
      start: (agentId: string) => invoke<ExecutionRun>('runs:start', agentId),
      stop: (runId: string) => invoke<void>('runs:stop', runId),
      getLog: (runId: string) => invoke<LogEntry[]>('runs:getLog', runId),
    },

    onOutput: (cb: (payload: RunOutputPayload) => void): (() => void) => {
      outputListeners.add(cb)
      return () => outputListeners.delete(cb)
    },

    onRunStatusChange: (cb: (payload: RunStatusChangePayload) => void): (() => void) => {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },

    gist: {
      save: (content: string, gistId?: string) =>
        invoke<string>('gist:save', content, gistId),
      load: (gistId: string) => invoke<string>('gist:load', gistId),
      list: () => invoke('gist:list') as any,
    },

    prefs: {
      get: <T>(key: string) => invoke<T | undefined>('prefs:get', key),
      set: (key: string, value: unknown) => invoke<void>('prefs:set', key, value),
    },

    shell: {
      openExternal: async (url: string): Promise<void> => {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
    },

    globalMcps: {
      list: () => invoke<GlobalMcpServer[]>('globalMcps:list'),
      create: (data: Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>) =>
        invoke<GlobalMcpServer>('globalMcps:create', data),
      update: (
        id: string,
        data: Partial<Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>>
      ) => invoke<GlobalMcpServer>('globalMcps:update', id, data),
      delete: (id: string) => invoke<void>('globalMcps:delete', id),
      checkHealth: (serverConfig: import('@shared/types').McpServerEntry) =>
        invoke<import('@shared/types').McpHealthResult>('globalMcps:checkHealth', serverConfig),
    },

    publishTargets: {
      list: () => invoke<PublishTarget[]>('publishTargets:list'),
      get: (id: string) => invoke<PublishTarget | null>('publishTargets:get', id),
      create: (data: Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>) =>
        invoke<PublishTarget>('publishTargets:create', data),
      update: (
        id: string,
        data: Partial<Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>>
      ) => invoke<PublishTarget>('publishTargets:update', id, data),
      delete: (id: string) => invoke<void>('publishTargets:delete', id),
      test: (config: SlackPublishConfig) =>
        invoke<{ success: boolean; error?: string }>('publishTargets:test', config),
    },

    mcpOAuth: {
      getToken: (serverUrl: string) => invoke<OAuthToken | null>('mcp:oauth:getToken', serverUrl),
      startAuth: (serverId: string, isGlobal: boolean) =>
        invoke<void>('mcp:oauth:startAuth', serverId, isGlobal),
      revokeToken: (serverUrl: string) => invoke<void>('mcp:oauth:revokeToken', serverUrl),
    },

    onMcpOAuthComplete: (
      cb: (payload: { serverUrl: string; success: boolean; error?: string }) => void
    ): (() => void) => {
      oauthCompleteListeners.add(cb)
      return () => oauthCompleteListeners.delete(cb)
    },

    promptChat: {
      start: (agentId: string, runner: RunnerType): Promise<string> =>
        invoke<string>('promptChat:start', agentId, runner),
      send: (sessionId: string, message: string): Promise<void> =>
        invoke<void>('promptChat:send', sessionId, message),
      close: (sessionId: string): Promise<void> =>
        invoke<void>('promptChat:close', sessionId),
    },

    onPromptChatToken: (
      cb: (payload: { sessionId: string; token: string }) => void
    ): (() => void) => {
      promptTokenListeners.add(cb)
      return () => promptTokenListeners.delete(cb)
    },

    onPromptChatDone: (
      cb: (payload: { sessionId: string; extractedPrompt?: string }) => void
    ): (() => void) => {
      promptDoneListeners.add(cb)
      return () => promptDoneListeners.delete(cb)
    },

    onPromptChatError: (
      cb: (payload: { sessionId: string; error: string }) => void
    ): (() => void) => {
      promptErrorListeners.add(cb)
      return () => promptErrorListeners.delete(cb)
    },
  }
}
