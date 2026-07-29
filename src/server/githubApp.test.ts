import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the GitHub App auth library: app JWT + installation token.
vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(() => async (opts: { type: string; installationId?: number }) => {
    if (opts.type === 'app') return { token: 'app-jwt' }
    if (opts.type === 'installation') return { token: `ghs_inst_${opts.installationId}` }
    throw new Error(`unexpected auth type ${opts.type}`)
  }),
}))

// Mock the persistence + crypto layers used by resolveRepoToken.
vi.mock('../main/db/queries/repositories', () => ({
  getRepositoryCredentials: vi.fn(),
}))
vi.mock('./crypto', () => ({
  decryptSecret: vi.fn(() => 'DECRYPTED-PEM'),
}))

import {
  parseGithubOwnerRepo,
  mintInstallationToken,
  resolveRepoToken,
  resolvePushCredential,
  githubTokenEnvEntry,
  isTransientGithubError,
  withTransientGithubRetry,
  GH_TOKEN_ENV_VAR,
} from './githubApp'
import { createAppAuth } from '@octokit/auth-app'
import { getRepositoryCredentials } from '../main/db/queries/repositories'
import { decryptSecret } from './crypto'

describe('parseGithubOwnerRepo', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'acme', 'widgets'],
    ['https://github.com/acme/widgets', 'acme', 'widgets'],
    ['https://x-access-token:tok@github.com/acme/widgets.git', 'acme', 'widgets'],
    ['git@github.com:acme/widgets.git', 'acme', 'widgets'],
    ['https://github.com/acme/widgets/', 'acme', 'widgets'],
    // HTTPS with userinfo AND a port must not be misread as scp-style SSH.
    ['https://user@github.example.com:8443/acme/widgets.git', 'acme', 'widgets'],
  ])('parses %s', (url, owner, repo) => {
    expect(parseGithubOwnerRepo(url)).toEqual({ owner, repo })
  })

  it('throws on an unparseable URL', () => {
    expect(() => parseGithubOwnerRepo('https://github.com/acme')).toThrow()
  })
})

describe('mintInstallationToken', () => {
  const realFetch = global.fetch
  afterEach(() => {
    vi.useRealTimers()
    global.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('discovers the installation and mints an installation token', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 4242 }),
    })) as unknown as typeof fetch

    const token = await mintInstallationToken({
      appId: '123',
      privateKey: 'PEM',
      repoUrl: 'https://github.com/acme/widgets.git',
    })

    expect(token).toBe('ghs_inst_4242')
    const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('https://api.github.com/repos/acme/widgets/installation')
    expect(call[1].headers.Authorization).toBe('Bearer app-jwt')
  })

  it('throws a helpful error when the app is not installed', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    })) as unknown as typeof fetch

    await expect(
      mintInstallationToken({ appId: '123', privateKey: 'PEM', repoUrl: 'https://github.com/acme/widgets' })
    ).rejects.toThrow(/not installed/i)
  })

  it('throws when the installation response lacks a numeric id', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: 'unexpected' }),
    })) as unknown as typeof fetch

    await expect(
      mintInstallationToken({ appId: '123', privateKey: 'PEM', repoUrl: 'https://github.com/acme/widgets' })
    ).rejects.toThrow(/unexpected response/i)
  })

  it('retries a transient 5xx discovering the installation, then succeeds', async () => {
    vi.useFakeTimers()
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'Bad Gateway' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 7 }) }) as unknown as typeof fetch

    const promise = mintInstallationToken({
      appId: '123',
      privateKey: 'PEM',
      repoUrl: 'https://github.com/acme/widgets',
    })
    await vi.runAllTimersAsync()

    await expect(promise).resolves.toBe('ghs_inst_7')
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 4xx discovering the installation', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    })) as unknown as typeof fetch

    await expect(
      mintInstallationToken({ appId: '123', privateKey: 'PEM', repoUrl: 'https://github.com/acme/widgets' })
    ).rejects.toThrow(/not installed/i)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('retries GitHub\'s "couldn\'t respond in time" minting the installation token', async () => {
    vi.useFakeTimers()
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 555 }),
    })) as unknown as typeof fetch

    // The Sentry CONDUIT-J failure: the POST minting the installation token
    // intermittently dies on GitHub's edge with this message.
    const installationAuth = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            "We couldn't respond to your request in time. Sorry about that. " +
              'Please try resubmitting your request and contact us if the problem persists.'
          ),
          { status: 502 }
        )
      )
      .mockResolvedValueOnce({ token: 'ghs_inst_555' })
    vi.mocked(createAppAuth).mockImplementationOnce(
      () => async (opts: { type: string; installationId?: number }) =>
        opts.type === 'app' ? { token: 'app-jwt' } : installationAuth(opts.installationId)
    )

    const promise = mintInstallationToken({
      appId: '123',
      privateKey: 'PEM',
      repoUrl: 'https://github.com/acme/widgets',
    })
    await vi.runAllTimersAsync()

    await expect(promise).resolves.toBe('ghs_inst_555')
    expect(installationAuth).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 4xx minting the installation token', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 555 }),
    })) as unknown as typeof fetch

    const installationAuth = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Bad credentials'), { status: 401 }))
    vi.mocked(createAppAuth).mockImplementationOnce(
      () => async (opts: { type: string; installationId?: number }) =>
        opts.type === 'app' ? { token: 'app-jwt' } : installationAuth(opts.installationId)
    )

    await expect(
      mintInstallationToken({ appId: '123', privateKey: 'PEM', repoUrl: 'https://github.com/acme/widgets' })
    ).rejects.toThrow(/Bad credentials/)
    expect(installationAuth).toHaveBeenCalledTimes(1)
  })
})

describe('isTransientGithubError', () => {
  it('treats 5xx statuses as transient', () => {
    expect(isTransientGithubError(Object.assign(new Error('boom'), { status: 500 }))).toBe(true)
    expect(isTransientGithubError(Object.assign(new Error('boom'), { status: 502 }))).toBe(true)
  })

  it('treats the "couldn\'t respond in time" message as transient even with a 4xx status', () => {
    const err = Object.assign(new Error("We couldn't respond to your request in time."), {
      status: 403,
    })
    expect(isTransientGithubError(err)).toBe(true)
  })

  it('treats network-level failures as transient', () => {
    expect(isTransientGithubError(new TypeError('fetch failed'))).toBe(true)
    expect(isTransientGithubError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))).toBe(true)
    expect(isTransientGithubError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true)
  })

  it('fails fast on 4xx auth/config errors', () => {
    expect(isTransientGithubError(Object.assign(new Error('Bad credentials'), { status: 401 }))).toBe(false)
    expect(isTransientGithubError(Object.assign(new Error('Not Found'), { status: 404 }))).toBe(false)
  })

  it('does not classify non-Error throws as transient', () => {
    expect(isTransientGithubError('boom')).toBe(false)
    expect(isTransientGithubError(undefined)).toBe(false)
  })
})

describe('withTransientGithubRetry', () => {
  it('retries a transient failure until it succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 502 }))
      .mockResolvedValueOnce('ok')

    await expect(withTransientGithubRetry(fn, { baseDelayMs: 0 })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry 4xx errors', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }))

    await expect(withTransientGithubRetry(fn, { baseDelayMs: 0 })).rejects.toThrow('nope')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt budget and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('still down'), { status: 500 }))

    await expect(withTransientGithubRetry(fn, { attempts: 3, baseDelayMs: 0 })).rejects.toThrow('still down')
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('resolveRepoToken', () => {
  const realFetch = global.fetch
  const origPat = process.env.GITHUB_PAT
  beforeEach(() => {
    vi.mocked(getRepositoryCredentials).mockReset()
    vi.mocked(decryptSecret).mockClear()
  })
  afterEach(() => {
    global.fetch = realFetch
    if (origPat === undefined) delete process.env.GITHUB_PAT
    else process.env.GITHUB_PAT = origPat
  })

  it('returns undefined for none/ssh', async () => {
    expect(await resolveRepoToken({ id: 'r1', url: 'https://github.com/a/b', authMethod: 'none' })).toBeUndefined()
    expect(await resolveRepoToken({ id: 'r1', url: 'https://github.com/a/b', authMethod: 'ssh' })).toBeUndefined()
  })

  it('returns the env PAT for pat auth', async () => {
    process.env.GITHUB_PAT = 'ghp_test'
    expect(await resolveRepoToken({ id: 'r1', url: 'https://github.com/a/b', authMethod: 'pat' })).toBe('ghp_test')
  })

  it('decrypts the stored key and mints a token for githubapp auth', async () => {
    vi.mocked(getRepositoryCredentials).mockResolvedValue({
      githubAppId: '123',
      githubPrivateKeyEnc: 'enc-blob',
    })
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 99 }) })) as unknown as typeof fetch

    const token = await resolveRepoToken({ id: 'r1', url: 'https://github.com/acme/widgets', authMethod: 'githubapp' })

    expect(decryptSecret).toHaveBeenCalledWith('enc-blob')
    expect(token).toBe('ghs_inst_99')
  })

  it('throws if githubapp auth is missing credentials', async () => {
    vi.mocked(getRepositoryCredentials).mockResolvedValue({ githubAppId: undefined, githubPrivateKeyEnc: undefined })
    await expect(
      resolveRepoToken({ id: 'r1', url: 'https://github.com/a/b', authMethod: 'githubapp' })
    ).rejects.toThrow(/missing/i)
  })
})

describe('resolvePushCredential', () => {
  const realFetch = global.fetch
  const origPat = process.env.GITHUB_PAT
  beforeEach(() => vi.mocked(getRepositoryCredentials).mockReset())
  afterEach(() => {
    global.fetch = realFetch
    if (origPat === undefined) delete process.env.GITHUB_PAT
    else process.env.GITHUB_PAT = origPat
  })

  it('returns the token and no error on success', async () => {
    process.env.GITHUB_PAT = 'ghp_test'
    const result = await resolvePushCredential({ id: 'r1', url: 'https://github.com/a/b', authMethod: 'pat' })
    expect(result).toEqual({ token: 'ghp_test' })
    expect(result.error).toBeUndefined()
  })

  it('captures the error instead of throwing when the mint fails', async () => {
    // githubapp auth with no stored credentials makes resolveRepoToken throw.
    vi.mocked(getRepositoryCredentials).mockResolvedValue({ githubAppId: undefined, githubPrivateKeyEnc: undefined })
    const result = await resolvePushCredential({ id: 'r1', url: 'https://github.com/a/b', authMethod: 'githubapp' })
    expect(result.token).toBeUndefined()
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error?.message).toMatch(/missing/i)
  })
})

describe('githubTokenEnvEntry', () => {
  it('exposes the resolved token as GH_TOKEN', () => {
    expect(githubTokenEnvEntry('ghp_abc')).toEqual({ [GH_TOKEN_ENV_VAR]: 'ghp_abc' })
    expect(GH_TOKEN_ENV_VAR).toBe('GH_TOKEN')
  })

  it('sets nothing when no token resolved (ssh/none or repo-less runs)', () => {
    expect(githubTokenEnvEntry(undefined)).toEqual({})
    expect(githubTokenEnvEntry('')).toEqual({})
  })

  it('lets an explicit per-agent GH_TOKEN win over the injected token', () => {
    expect(githubTokenEnvEntry('ghp_repo', { GH_TOKEN: 'ghp_agent' })).toEqual({})
  })

  it('injects when the agent sets unrelated envVars but not GH_TOKEN', () => {
    expect(githubTokenEnvEntry('ghp_repo', { FOO: 'bar' })).toEqual({ [GH_TOKEN_ENV_VAR]: 'ghp_repo' })
  })
})
