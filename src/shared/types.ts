export type RunnerType = 'claude' | 'amp' | 'cursor'

export interface GistFile {
  filename: string
  language: string | null
  size: number
  truncated?: boolean
  content?: string
}

export interface GistSummary {
  id: string
  description: string
  files: Record<string, GistFile>
  createdAt: string
  updatedAt: string
  public: boolean
  htmlUrl: string
  /** true when the gist contains a prompt.md file (Conduit-managed) */
  isConduitPrompt: boolean
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface PromptChatSession {
  id: string
  agentId: string
  runner: RunnerType
  messages: ChatMessage[]
  extractedPrompt?: string
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'launched'

export interface McpOAuthConfig {
  clientId: string
  authorizationUrl: string  // override discovery if known
  tokenUrl: string          // override discovery if known
  scopes: string[]
}

export interface McpServerEntry {
  command?: string
  args?: string[]
  type?: 'url' | 'stdio'
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
  oauth?: McpOAuthConfig
}

export interface OAuthToken {
  serverUrl: string
  accessToken: string
  refreshToken?: string
  expiresAt?: number   // unix ms, undefined = no expiry
  tokenType: string    // 'Bearer'
  scope?: string
}

export interface McpServersConfig {
  mcpServers: Record<string, McpServerEntry>
}

export interface AgentConfig {
  id: string
  name: string
  runner: RunnerType
  prompt: string
  envVars: Record<string, string>
  mcpConfig: McpServersConfig
  gistId?: string
  /** If set, the agent runs in this directory instead of an ephemeral workspace */
  workingDir?: string
  /** IDs of publish targets to notify when a run completes */
  publishTargetIds?: string[]
  /** ID of a managed repository to use as the workspace */
  repositoryId?: string
  createdAt: number
  updatedAt: number
}

export interface ExecutionRun {
  id: string
  agentId: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  workspacePath?: string
  logPath: string
  exitCode?: number
}

export interface LogEntry {
  t: number
  stream: 'stdout' | 'stderr' | 'system'
  chunk: string
}

export interface RunOutputPayload {
  runId: string
  stream: 'stdout' | 'stderr' | 'system'
  chunks: string[]
}

export interface RunStatusChangePayload {
  runId: string
  status: RunStatus
  exitCode?: number
  endedAt?: number
  durationMs?: number
}

export interface McpHealthResult {
  status: 'healthy' | 'unhealthy'
  message: string
}

export interface McpToolInfo {
  name: string
  description?: string
}

export interface McpToolsResult {
  tools: McpToolInfo[]
  error?: string
}

export interface GlobalMcpServer {
  id: string
  name: string
  serverKey: string
  serverConfig: McpServerEntry
  enabled: boolean
  createdAt: number
  updatedAt: number
}

// ── Repositories ────────────────────────────────────────────────────────────

export type RepoSyncStatus = 'pending' | 'cloning' | 'ready' | 'syncing' | 'error'

export interface Repository {
  id: string
  name: string
  url: string
  defaultBranch: string
  authMethod: 'none' | 'pat' | 'ssh'
  syncStatus: RepoSyncStatus
  syncError?: string
  lastSyncedAt?: number
  clonePath?: string
  createdAt: number
  updatedAt: number
}

export interface RepoSyncStatusPayload {
  repoId: string
  syncStatus: RepoSyncStatus
  syncError?: string
  lastSyncedAt?: number
}

// ── Publish Targets ─────────────────────────────────────────────────────────

export type PublishTargetType = 'slack' | 'email' | 'webhook'

export interface SlackPublishConfig {
  /** Slack Bot User OAuth Token (xoxb-...) — used for chat.postMessage */
  botToken?: string
  /** Incoming Webhook URL — alternative to bot token */
  webhookUrl?: string
  /** Channel or user ID to post to (required for bot token mode) */
  channel: string
  /** Emoji icon for the bot (e.g. :robot_face:) — optional override */
  iconEmoji?: string
}

export interface EmailPublishConfig {
  /** SMTP host */
  smtpHost: string
  /** SMTP port (default 587) */
  smtpPort: number
  /** SMTP username */
  smtpUser: string
  /** SMTP password or app password */
  smtpPass: string
  /** Use TLS (default true) */
  smtpSecure: boolean
  /** From address */
  from: string
  /** Comma-separated recipient addresses */
  to: string
  /** Email subject template — {{agentName}} and {{status}} are replaced */
  subject: string
}

export interface WebhookPublishConfig {
  /** URL to POST to */
  url: string
  /** HTTP method (default POST) */
  method: 'POST' | 'PUT'
  /** Optional headers as key-value pairs */
  headers: Record<string, string>
  /** Optional shared secret for HMAC-SHA256 signature in X-Conduit-Signature header */
  secret?: string
}

export type PublishConfig = SlackPublishConfig | EmailPublishConfig | WebhookPublishConfig

export interface PublishTarget {
  id: string
  name: string
  type: PublishTargetType
  config: PublishConfig
  enabled: boolean
  createdAt: number
  updatedAt: number
}

// IPC API surface exposed via contextBridge
export interface ConduitAPI {
  agents: {
    list: () => Promise<AgentConfig[]>
    get: (id: string) => Promise<AgentConfig | null>
    create: (data: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>) => Promise<AgentConfig>
    update: (id: string, data: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<AgentConfig>
    delete: (id: string) => Promise<void>
  }
  runs: {
    list: (agentId: string) => Promise<ExecutionRun[]>
    start: (agentId: string) => Promise<ExecutionRun>
    stop: (runId: string) => Promise<void>
    getLog: (runId: string) => Promise<LogEntry[]>
  }
  onOutput: (cb: (payload: RunOutputPayload) => void) => () => void
  onRunStatusChange: (cb: (payload: RunStatusChangePayload) => void) => () => void
  gist: {
    save: (content: string, gistId?: string) => Promise<string>
    load: (gistId: string) => Promise<string>
    list: () => Promise<GistSummary[]>
  }
  prefs: {
    get: <T>(key: string) => Promise<T | undefined>
    set: (key: string, value: unknown) => Promise<void>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  globalMcps: {
    list: () => Promise<GlobalMcpServer[]>
    create: (data: Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>) => Promise<GlobalMcpServer>
    update: (id: string, data: Partial<Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<GlobalMcpServer>
    delete: (id: string) => Promise<void>
    checkHealth: (serverConfig: McpServerEntry) => Promise<McpHealthResult>
    listTools: (serverConfig: McpServerEntry) => Promise<McpToolsResult>
  }
  repos: {
    list: () => Promise<Repository[]>
    get: (id: string) => Promise<Repository | null>
    create: (data: Omit<Repository, 'id' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'clonePath'>) => Promise<Repository>
    update: (id: string, data: Partial<Omit<Repository, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<Repository>
    delete: (id: string) => Promise<void>
    triggerSync: (id: string) => Promise<void>
    testConnection: (data: { url: string; authMethod: 'none' | 'pat' | 'ssh' }) => Promise<{ success: boolean; message: string }>
  }
  onRepoSyncStatus: (cb: (payload: RepoSyncStatusPayload) => void) => () => void
  publishTargets: {
    list: () => Promise<PublishTarget[]>
    get: (id: string) => Promise<PublishTarget | null>
    create: (data: Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>) => Promise<PublishTarget>
    update: (id: string, data: Partial<Omit<PublishTarget, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<PublishTarget>
    delete: (id: string) => Promise<void>
    test: (type: PublishTargetType, config: PublishConfig) => Promise<{ success: boolean; error?: string }>
  }
  mcpOAuth: {
    getToken: (serverUrl: string) => Promise<OAuthToken | null>
    startAuth: (serverId: string, isGlobal: boolean) => Promise<void>
    revokeToken: (serverUrl: string) => Promise<void>
  }
  onMcpOAuthComplete: (
    cb: (payload: { serverUrl: string; success: boolean; error?: string }) => void
  ) => () => void
  promptChat: {
    start: (agentId: string, runner: RunnerType) => Promise<string>
    send: (sessionId: string, message: string) => Promise<void>
    close: (sessionId: string) => Promise<void>
  }
  onPromptChatToken: (cb: (payload: { sessionId: string; token: string }) => void) => () => void
  onPromptChatDone: (cb: (payload: { sessionId: string; extractedPrompt?: string }) => void) => () => void
  onPromptChatError: (cb: (payload: { sessionId: string; error: string }) => void) => () => void
}

declare global {
  interface Window {
    conduit: ConduitAPI
  }
}
