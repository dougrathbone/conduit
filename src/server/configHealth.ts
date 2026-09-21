import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'
import { getDb } from '../main/db/index'
import { agentCredentials, oauthTokens } from '../main/db/schema'
import { listGlobalMcps } from '../main/db/queries/globalMcps'
import { encryptSecret, decryptSecret } from './crypto'
import { probeMcpServerHealth } from './mcpHealth'
import type {
  AppConfigHealth,
  ConfigHealthStatus,
  EncryptionConfigHealth,
  GitConfigHealth,
  McpAttentionItem,
  McpConfigHealth,
  McpHealthResult,
  McpServerEntry,
  RequestContext,
} from '../shared/types'

const runFile = promisify(execFile)

export interface GitProbe {
  whichGit: () => Promise<string>
  gitVersion: () => Promise<string>
}

export interface EncryptionProbe {
  env: NodeJS.ProcessEnv
  nodeEnv: string | undefined
  localKeyPath: string
  readLocalKey: () => string | null
  sampleEncryptedBlobs: () => Promise<string[]>
}

export interface McpProbe {
  listEnabled: () => Promise<{ id: string; name: string; serverConfig: McpServerEntry }[]>
  probe: (config: McpServerEntry) => Promise<McpHealthResult>
}

function overallOk(git: GitConfigHealth, encryption: EncryptionConfigHealth, mcps: McpConfigHealth): boolean {
  return git.status === 'ok' && encryption.status === 'ok' && mcps.status === 'ok'
}

export function assembleConfigHealth(
  git: GitConfigHealth,
  encryption: EncryptionConfigHealth,
  mcps: McpConfigHealth
): AppConfigHealth {
  return { git, encryption, mcps, ok: overallOk(git, encryption, mcps) }
}

export async function checkGit(probe: GitProbe = defaultGitProbe()): Promise<GitConfigHealth> {
  try {
    const binPath = (await probe.whichGit()).trim()
    if (!binPath) {
      return {
        status: 'error',
        installed: false,
        message: 'git is not on PATH — managed repositories cannot clone or create worktrees.',
      }
    }
    let version: string | undefined
    try {
      const raw = (await probe.gitVersion()).trim()
      version = raw.replace(/^git version\s+/i, '') || raw
    } catch {
      version = undefined
    }
    return {
      status: 'ok',
      installed: true,
      path: binPath,
      version,
      message: version ? `git ${version} at ${binPath}` : `git found at ${binPath}`,
    }
  } catch {
    return {
      status: 'error',
      installed: false,
      message: 'git is not on PATH — managed repositories cannot clone or create worktrees.',
    }
  }
}

function defaultGitProbe(): GitProbe {
  return {
    whichGit: async () => {
      const { stdout } = await runFile('which', ['git'])
      return stdout
    },
    gitVersion: async () => {
      const { stdout } = await runFile('git', ['--version'])
      return stdout
    },
  }
}

function detectKeySource(probe: EncryptionProbe): EncryptionConfigHealth['source'] {
  const hex = probe.env.CONDUIT_SECRET_KEY
  if (!hex) return 'none'
  if (probe.nodeEnv === 'production') return 'environment'
  try {
    const local = probe.readLocalKey()
    if (local && local === hex) return 'local-file'
  } catch {
    // Fall through to environment.
  }
  return 'environment'
}

export async function checkEncryption(
  probe: EncryptionProbe = defaultEncryptionProbe()
): Promise<EncryptionConfigHealth> {
  const source = detectKeySource(probe)
  if (source === 'none') {
    return {
      status: 'error',
      configured: false,
      working: false,
      source,
      storedSecrets: 'none',
      message:
        'CONDUIT_SECRET_KEY is not set. Secrets (API keys, GitHub App PEMs, MCP OAuth tokens) cannot be encrypted at rest.',
    }
  }

  try {
    const roundtrip = decryptSecret(encryptSecret('conduit-config-health'))
    if (roundtrip !== 'conduit-config-health') {
      return {
        status: 'error',
        configured: true,
        working: false,
        source,
        storedSecrets: 'none',
        message: 'Encryption key is set but a round-trip encrypt/decrypt did not match.',
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      status: 'error',
      configured: true,
      working: false,
      source,
      storedSecrets: 'none',
      message: msg,
    }
  }

  let storedSecrets: EncryptionConfigHealth['storedSecrets'] = 'none'
  try {
    const blobs = await probe.sampleEncryptedBlobs()
    if (blobs.length > 0) {
      try {
        for (const blob of blobs) decryptSecret(blob)
        storedSecrets = 'readable'
      } catch {
        storedSecrets = 'unreadable'
      }
    }
  } catch {
    storedSecrets = 'none'
  }

  if (storedSecrets === 'unreadable') {
    return {
      status: 'error',
      configured: true,
      working: false,
      source,
      storedSecrets,
      message:
        'The current key encrypts new data, but existing stored secrets cannot be decrypted. CONDUIT_SECRET_KEY was likely rotated or does not match the key used to write them.',
    }
  }

  const message =
    source === 'local-file'
      ? 'Dev key from .conduit.key is working. Set CONDUIT_SECRET_KEY explicitly in production.'
      : storedSecrets === 'readable'
        ? 'CONDUIT_SECRET_KEY is set and can decrypt stored secrets.'
        : 'CONDUIT_SECRET_KEY is set and a round-trip encrypt/decrypt succeeded.'

  return {
    status: 'ok',
    configured: true,
    working: true,
    source,
    storedSecrets,
    message,
  }
}

function defaultEncryptionProbe(): EncryptionProbe {
  const localKeyPath = path.join(process.cwd(), '.conduit.key')
  return {
    env: process.env,
    nodeEnv: process.env.NODE_ENV,
    localKeyPath,
    readLocalKey: () => {
      if (!fs.existsSync(localKeyPath)) return null
      return fs.readFileSync(localKeyPath, 'utf8').trim()
    },
    sampleEncryptedBlobs: async () => {
      const db = getDb()
      const blobs: string[] = []
      const tokens = await db
        .select({ accessToken: oauthTokens.accessToken })
        .from(oauthTokens)
        .limit(1)
      if (tokens[0]?.accessToken) blobs.push(tokens[0].accessToken)
      const creds = await db
        .select({ valueEnc: agentCredentials.valueEnc })
        .from(agentCredentials)
        .limit(1)
      if (creds[0]?.valueEnc) blobs.push(creds[0].valueEnc)
      return blobs
    },
  }
}

export function summarizeMcpHealth(
  enabledCount: number,
  attention: McpAttentionItem[]
): McpConfigHealth {
  if (enabledCount === 0) {
    return {
      status: 'ok',
      enabledCount,
      attention,
      message: 'No enabled global MCP servers.',
    }
  }
  if (attention.length === 0) {
    return {
      status: 'ok',
      enabledCount,
      attention,
      message:
        enabledCount === 1
          ? 'The enabled global MCP server is healthy.'
          : `All ${enabledCount} enabled global MCP servers are healthy.`,
    }
  }

  const unauthorized = attention.filter((a) => a.status === 'unauthorized').length
  const unhealthy = attention.filter((a) => a.status === 'unhealthy').length
  const status: ConfigHealthStatus = unhealthy > 0 ? 'error' : 'warn'
  const parts: string[] = []
  if (unauthorized) {
    parts.push(
      `${unauthorized} need${unauthorized === 1 ? 's' : ''} authentication`
    )
  }
  if (unhealthy) {
    parts.push(`${unhealthy} unreachable or misconfigured`)
  }
  return {
    status,
    enabledCount,
    attention,
    message: parts.join('; ') + '.',
  }
}

export async function checkMcps(probe: McpProbe): Promise<McpConfigHealth> {
  const servers = await probe.listEnabled()
  const results = await Promise.all(
    servers.map(async (server) => {
      const health = await probe.probe(server.serverConfig)
      return { server, health }
    })
  )
  const attention: McpAttentionItem[] = []
  for (const { server, health } of results) {
    if (health.status === 'healthy') continue
    attention.push({
      id: server.id,
      name: server.name,
      status: health.status,
      message: health.message,
    })
  }
  return summarizeMcpHealth(servers.length, attention)
}

function defaultMcpProbe(ctx: RequestContext): McpProbe {
  return {
    listEnabled: async () => {
      const all = await listGlobalMcps(ctx.userId, ctx.userGroupIds)
      return all.filter((s) => s.enabled)
    },
    probe: probeMcpServerHealth,
  }
}

export async function getConfigHealth(ctx: RequestContext): Promise<AppConfigHealth> {
  const [git, encryption, mcps] = await Promise.all([
    checkGit(),
    checkEncryption(),
    checkMcps(defaultMcpProbe(ctx)),
  ])
  return assembleConfigHealth(git, encryption, mcps)
}
