import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { initDb } from '../main/db/index'
import { listAgents, getAgent, createAgent, updateAgent, deleteAgent } from '../main/db/queries/agents'
import { listRuns, updateRun, getOrphanedRuns } from '../main/db/queries/runs'
import { startRunServer, stopRun } from './runner'
import {
  listGlobalMcps,
  createGlobalMcp,
  updateGlobalMcp,
  deleteGlobalMcp,
} from '../main/db/queries/globalMcps'
import { getGithubPat, setGithubPat, serverStoreGet, serverStoreSet } from './store'
import { readLogFile } from './utils'
import { Octokit } from '@octokit/rest'
import { createSession, sendMessageServer, closeSession } from './promptChatServer'
import { loadIpRestrictionsConfig, isIpAllowed, extractClientIp } from './ipRestrictions'
import { createIpRestrictionMiddleware } from './middleware/ipRestriction'
import type {
  AgentConfig,
  GlobalMcpServer,
  RunnerType,
} from '../shared/types'

const PORT = process.env.PORT || 7456

const DATA_DIR = process.env.CONDUIT_DATA_DIR ?? path.join(os.homedir(), '.conduit')
// Ensure it exists
fs.mkdirSync(DATA_DIR, { recursive: true })

const app = express()
const httpServer = createServer(app)

// WebSocket server — not attached directly to httpServer so we can restrict
// upgrades to the /ws path only.
const wss = new WebSocketServer({ noServer: true })

// Serve the built renderer static files.
// Use process.cwd() so this resolves correctly whether running via:
//   - tsx src/server/index.ts  (__dirname = src/server/)
//   - node out/server/index.js (__dirname = out/server/)
const RENDERER_DIR = path.join(process.cwd(), 'out', 'renderer')

// ─── IP Restrictions ──────────────────────────────────────────────────────────

const ipConfig = loadIpRestrictionsConfig(DATA_DIR)
if (ipConfig.enabled) {
  console.log(`[conduit] IP restrictions enabled. Allowed: ${ipConfig.allowedCidrs.join(', ')}`)
}

app.use(createIpRestrictionMiddleware(ipConfig))

app.use(express.static(RENDERER_DIR))
// SPA fallback — all non-API routes serve index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(RENDERER_DIR, 'index.html'))
})

// ─── Active clients ───────────────────────────────────────────────────────────

const clients = new Set<WebSocket>()

function broadcast(channel: string, payload: unknown): void {
  const msg = JSON.stringify({ type: 'event', channel, payload })
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
    }
  }
}

// ─── Channel handlers ─────────────────────────────────────────────────────────

type HandlerFn = (args: unknown[], ws: WebSocket) => Promise<unknown>

const handlers: Record<string, HandlerFn> = {
  // Agents
  'agents:list': () => Promise.resolve(listAgents()),
  'agents:get': ([id]) => Promise.resolve(getAgent(id as string)),
  'agents:create': ([data]) =>
    Promise.resolve(createAgent(data as Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>)),
  'agents:update': ([id, data]) =>
    Promise.resolve(
      updateAgent(
        id as string,
        data as Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>
      )
    ),
  'agents:delete': ([id]) => {
    deleteAgent(id as string)
    return Promise.resolve()
  },

  // Runs
  'runs:list': ([agentId]) => Promise.resolve(listRuns(agentId as string)),
  'runs:start': ([agentId]) => startRunServer(agentId as string, broadcast),
  'runs:stop': ([runId]) => stopRun(runId as string),
  'runs:getLog': ([runId]) => Promise.resolve(readLogFile(runId as string)),

  // Global MCPs
  'globalMcps:list': () => Promise.resolve(listGlobalMcps()),
  'globalMcps:create': ([data]) =>
    Promise.resolve(
      createGlobalMcp(data as Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>)
    ),
  'globalMcps:update': ([id, data]) =>
    Promise.resolve(
      updateGlobalMcp(
        id as string,
        data as Partial<Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>>
      )
    ),
  'globalMcps:delete': ([id]) => {
    deleteGlobalMcp(id as string)
    return Promise.resolve()
  },

  // Gist
  'gist:save': async ([content, gistId]) => {
    const pat = getGithubPat()
    if (!pat) throw new Error('GitHub PAT not configured')
    const octokit = new Octokit({ auth: pat })

    if (gistId) {
      const response = await octokit.gists.update({
        gist_id: gistId as string,
        files: { 'prompt.md': { content: content as string } },
      })
      return response.data.id!
    } else {
      const response = await octokit.gists.create({
        description: 'Conduit agent prompt',
        public: false,
        files: { 'prompt.md': { content: content as string } },
      })
      return response.data.id!
    }
  },

  'gist:list': async () => {
    const pat = getGithubPat()
    if (!pat) throw new Error('GitHub PAT not configured')
    const octokit = new Octokit({ auth: pat })
    const response = await octokit.gists.list({ per_page: 100 })
    return response.data.map((g) => ({
      id: g.id,
      description: g.description ?? '',
      files: Object.fromEntries(
        Object.entries(g.files ?? {}).map(([name, f]) => [
          name,
          { filename: f?.filename ?? name, language: f?.language ?? null, size: f?.size ?? 0 },
        ])
      ),
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      public: g.public,
      htmlUrl: g.html_url,
      isConduitPrompt: 'prompt.md' in (g.files ?? {}),
    }))
  },

  'gist:load': async ([gistId]) => {
    const pat = getGithubPat()
    if (!pat) throw new Error('GitHub PAT not configured')
    const octokit = new Octokit({ auth: pat })

    const response = await octokit.gists.get({ gist_id: gistId as string })
    const file = response.data.files?.['prompt.md']

    if (!file) {
      throw new Error(`Gist ${String(gistId)} does not contain a prompt.md file`)
    }

    return file.content ?? ''
  },

  // Preferences — special-case githubPat to use the server store's PAT helpers
  'prefs:get': ([key]) => {
    if (key === 'githubPat') {
      return Promise.resolve(getGithubPat())
    }
    return Promise.resolve(serverStoreGet(key as string))
  },
  'prefs:set': ([key, value]) => {
    if (key === 'githubPat') {
      if (typeof value === 'string') setGithubPat(value)
    } else {
      serverStoreSet(key as string, value)
    }
    return Promise.resolve()
  },

  // Shell — cannot open a browser from the server; return the URL so the client
  // can handle it (the ws-client polyfill calls window.open directly anyway).
  'shell:openExternal': ([url]) => Promise.resolve({ url }),

  // Prompt Chat
  'promptChat:start': ([agentId, runner]) =>
    createSession(agentId as string, runner as RunnerType),
  'promptChat:send': ([sessionId, message], ws) => {
    // We need a per-client broadcast so only this ws receives the streaming events
    function clientBroadcast(channel: string, payload: unknown): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'event', channel, payload }))
      }
    }
    return sendMessageServer(sessionId as string, message as string, clientBroadcast)
  },
  'promptChat:close': ([sessionId]) => {
    closeSession(sessionId as string)
    return Promise.resolve()
  },
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  clients.add(ws)

  ws.on('message', async (raw) => {
    let msg: { type: string; id: string; channel: string; args?: unknown[] }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return // Ignore malformed frames
    }

    if (msg.type !== 'invoke') return

    const handler = handlers[msg.channel]
    if (!handler) {
      ws.send(
        JSON.stringify({
          type: 'error',
          id: msg.id,
          error: `Unknown channel: ${msg.channel}`,
        })
      )
      return
    }

    try {
      const result = await handler(msg.args ?? [], ws)
      ws.send(JSON.stringify({ type: 'response', id: msg.id, result }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      ws.send(JSON.stringify({ type: 'error', id: msg.id, error: message }))
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
  })
})

// Only upgrade /ws path to WebSocket — leave all other HTTP routes alone
httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    const clientIp = extractClientIp(req.socket.remoteAddress, req.headers as any)
    if (!isIpAllowed(clientIp, ipConfig)) {
      console.warn(`[conduit] Blocked WebSocket from ${clientIp}`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket as import('net').Socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  } else {
    socket.destroy()
  }
})

// ─── Startup ──────────────────────────────────────────────────────────────────

// Initialise the SQLite database (creates tables if they don't exist)
initDb()

// Mark any runs that were left in "running" state as failed (server restart)
const orphaned = getOrphanedRuns()
for (const run of orphaned) {
  updateRun(run.id, { status: 'failed', endedAt: Date.now() })
}
if (orphaned.length > 0) {
  console.log(`[server] Marked ${orphaned.length} orphaned run(s) as failed`)
}

httpServer.listen(PORT, () => {
  console.log(`Conduit server running at http://localhost:${PORT}`)
})
