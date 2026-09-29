import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  assembleConfigHealth,
  checkEncryption,
  checkGit,
  checkMcps,
  summarizeMcpHealth,
  type EncryptionProbe,
  type GitProbe,
} from './configHealth'
import type { GitConfigHealth, EncryptionConfigHealth, McpConfigHealth } from '../shared/types'

const VALID_KEY = 'a'.repeat(64)

function okGit(): GitConfigHealth {
  return { status: 'ok', installed: true, path: '/usr/bin/git', version: '2.43.0', message: 'git 2.43.0' }
}

function okEncryption(): EncryptionConfigHealth {
  return {
    status: 'ok',
    configured: true,
    working: true,
    source: 'environment',
    storedSecrets: 'none',
    message: 'ok',
  }
}

function okMcps(): McpConfigHealth {
  return { status: 'ok', enabledCount: 0, attention: [], message: 'No enabled global MCP servers.' }
}

describe('assembleConfigHealth', () => {
  it('is ok only when every check is ok', () => {
    expect(assembleConfigHealth(okGit(), okEncryption(), okMcps()).ok).toBe(true)
    expect(
      assembleConfigHealth({ ...okGit(), status: 'error', installed: false }, okEncryption(), okMcps()).ok
    ).toBe(false)
    expect(
      assembleConfigHealth(okGit(), okEncryption(), { ...okMcps(), status: 'warn' }).ok
    ).toBe(false)
  })
})

describe('checkGit', () => {
  it('reports installed git with version', async () => {
    const probe: GitProbe = {
      whichGit: async () => '/usr/bin/git\n',
      gitVersion: async () => 'git version 2.43.0\n',
    }
    const result = await checkGit(probe)
    expect(result).toMatchObject({
      status: 'ok',
      installed: true,
      path: '/usr/bin/git',
      version: '2.43.0',
    })
    expect(result.message).toContain('2.43.0')
  })

  it('errors when git is missing', async () => {
    const probe: GitProbe = {
      whichGit: async () => {
        throw new Error('not found')
      },
      gitVersion: async () => {
        throw new Error('not found')
      },
    }
    const result = await checkGit(probe)
    expect(result.status).toBe('error')
    expect(result.installed).toBe(false)
    expect(result.message).toMatch(/not on PATH/)
  })
})

describe('checkEncryption', () => {
  const original = process.env.CONDUIT_SECRET_KEY
  beforeEach(() => {
    process.env.CONDUIT_SECRET_KEY = VALID_KEY
  })
  afterEach(() => {
    if (original === undefined) delete process.env.CONDUIT_SECRET_KEY
    else process.env.CONDUIT_SECRET_KEY = original
  })

  function baseProbe(overrides: Partial<EncryptionProbe> = {}): EncryptionProbe {
    return {
      env: process.env,
      nodeEnv: 'production',
      localKeyPath: '/tmp/.conduit.key',
      readLocalKey: () => null,
      sampleEncryptedBlobs: async () => [],
      ...overrides,
    }
  }

  it('errors when the key is missing', async () => {
    delete process.env.CONDUIT_SECRET_KEY
    const result = await checkEncryption(baseProbe({ env: {} }))
    expect(result.status).toBe('error')
    expect(result.configured).toBe(false)
    expect(result.source).toBe('none')
  })

  it('round-trips a valid key', async () => {
    const result = await checkEncryption(baseProbe())
    expect(result.status).toBe('ok')
    expect(result.working).toBe(true)
    expect(result.source).toBe('environment')
    expect(result.storedSecrets).toBe('none')
  })

  it('detects a local-dev key file that matches the env', async () => {
    const result = await checkEncryption(
      baseProbe({
        nodeEnv: 'development',
        readLocalKey: () => VALID_KEY,
      })
    )
    expect(result.status).toBe('ok')
    expect(result.source).toBe('local-file')
    expect(result.message).toMatch(/\.conduit\.key/)
  })

  it('flags stored secrets the current key cannot decrypt', async () => {
    const { encryptSecret } = await import('./crypto')
    const good = encryptSecret('ok')
    const result = await checkEncryption(
      baseProbe({
        sampleEncryptedBlobs: async () => [good, 'not-a-valid-blob'],
      })
    )
    expect(result.status).toBe('error')
    expect(result.working).toBe(false)
    expect(result.storedSecrets).toBe('unreadable')
    expect(result.message).toMatch(/rotated/)
  })

  it('reports readable stored secrets', async () => {
    const { encryptSecret } = await import('./crypto')
    const blob = encryptSecret('stored')
    const result = await checkEncryption(
      baseProbe({
        sampleEncryptedBlobs: async () => [blob],
      })
    )
    expect(result.status).toBe('ok')
    expect(result.storedSecrets).toBe('readable')
    expect(result.working).toBe(true)
  })

  it('errors on a malformed key even if it is set', async () => {
    process.env.CONDUIT_SECRET_KEY = 'abcd'
    const result = await checkEncryption(baseProbe({ env: process.env }))
    expect(result.status).toBe('error')
    expect(result.configured).toBe(true)
    expect(result.working).toBe(false)
    expect(result.message).toMatch(/32 bytes/)
  })
})

describe('summarizeMcpHealth', () => {
  it('is ok with no enabled servers', () => {
    const result = summarizeMcpHealth(0, [])
    expect(result.status).toBe('ok')
    expect(result.message).toMatch(/No enabled/)
  })

  it('is ok when every enabled server is healthy', () => {
    const result = summarizeMcpHealth(2, [])
    expect(result.status).toBe('ok')
    expect(result.message).toMatch(/All 2/)
  })

  it('warns when servers need authentication', () => {
    const result = summarizeMcpHealth(2, [
      { id: 'a', name: 'Linear', status: 'unauthorized', message: 'HTTP 401' },
    ])
    expect(result.status).toBe('warn')
    expect(result.message).toMatch(/authentication/)
  })

  it('errors when any server is unhealthy', () => {
    const result = summarizeMcpHealth(2, [
      { id: 'a', name: 'Broken', status: 'unhealthy', message: 'timeout' },
      { id: 'b', name: 'Linear', status: 'unauthorized', message: 'HTTP 401' },
    ])
    expect(result.status).toBe('error')
    expect(result.message).toMatch(/authentication/)
    expect(result.message).toMatch(/unreachable/)
  })
})

describe('checkMcps', () => {
  it('collects non-healthy enabled servers', async () => {
    const result = await checkMcps({
      listEnabled: async () => [
        { id: '1', name: 'Good', serverConfig: { type: 'url', url: 'https://ok.example' } },
        { id: '2', name: 'Auth', serverConfig: { type: 'url', url: 'https://auth.example' } },
        { id: '3', name: 'Down', serverConfig: { type: 'url', url: 'https://down.example' } },
      ],
      probe: async (config) => {
        if (config.url?.includes('ok')) return { status: 'healthy', message: 'OK' }
        if (config.url?.includes('auth')) return { status: 'unauthorized', message: 'HTTP 401' }
        return { status: 'unhealthy', message: 'timeout' }
      },
    })
    expect(result.enabledCount).toBe(3)
    expect(result.status).toBe('error')
    expect(result.attention.map((a) => a.name)).toEqual(['Auth', 'Down'])
  })
})
