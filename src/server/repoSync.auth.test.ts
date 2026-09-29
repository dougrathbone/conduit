import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Repository } from '../shared/types'

// Stub the impure dependencies (persistence, git, auth, reporter) so importing
// the service is side-effect-free (mirrors memoryPressure.test.ts).
vi.mock('./observability', () => ({
  reporter: { captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() },
}))
vi.mock('../main/db/queries/repositories', () => ({
  listRepositories: vi.fn(),
  getRepository: vi.fn(),
  updateRepository: vi.fn(),
}))
vi.mock('./githubApp', () => ({
  resolveRepoToken: vi.fn(),
}))
vi.mock('./gitOps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gitOps')>()),
  cloneRepo: vi.fn(),
  fetchRepo: vi.fn(),
}))

import {
  RepoSyncService,
  isRepoAuthenticationError,
  repositoryUpdateNeedsSync,
} from './repoSync'
import { reporter } from './observability'
import { getRepository, updateRepository } from '../main/db/queries/repositories'
import { resolveRepoToken } from './githubApp'
import { cloneRepo, fetchRepo } from './gitOps'

describe('repositoryUpdateNeedsSync', () => {
  it('is false for a name-only update', () => {
    expect(repositoryUpdateNeedsSync({ name: 'renamed' })).toBe(false)
  })

  it.each(['url', 'authMethod', 'githubAppId', 'githubPrivateKey'] as const)(
    'is true when %s is supplied',
    (field) => {
      const input =
        field === 'authMethod'
          ? { authMethod: 'githubapp' as const }
          : field === 'url'
            ? { url: 'https://github.com/acme/other.git' }
            : { [field]: 'updated' }
      expect(repositoryUpdateNeedsSync(input)).toBe(true)
    }
  )
})

describe('isRepoAuthenticationError', () => {
  it.each([
    'fatal: Authentication failed for https://github.com/acme/widgets.git',
    'remote: Invalid username or token. Password authentication is not supported.',
    'could not read Username for https://github.com',
    'ERROR: Repository not found.',
  ])('returns true for %s', (message) => {
    expect(isRepoAuthenticationError(message)).toBe(true)
  })

  it.each([
    'git fetch timed out after 600000ms',
    'The requested URL returned error: 503',
    'ENOSPC: no space left on device',
  ])('returns false for %s', (message) => {
    expect(isRepoAuthenticationError(message)).toBe(false)
  })
})

const PAT_REPO: Repository = {
  id: 'repo-1',
  name: 'widgets',
  url: 'https://github.com/acme/widgets.git',
  defaultBranch: 'main',
  authMethod: 'pat',
  syncStatus: 'pending',
  clonePath: '/data/repos/repo-1',
  createdAt: 0,
  updatedAt: 0,
}

describe('RepoSyncService credential failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getRepository).mockResolvedValue(PAT_REPO)
    vi.mocked(updateRepository).mockResolvedValue(PAT_REPO)
  })

  it('records an unresolvable PAT credential as a repo failure but reports only a warning', async () => {
    vi.mocked(resolveRepoToken).mockResolvedValue(undefined)

    await new RepoSyncService(vi.fn()).syncRepo(PAT_REPO.id)

    expect(reporter.captureException).not.toHaveBeenCalled()
    expect(reporter.captureMessage).toHaveBeenCalledOnce()
    const [message, level, ctx] = vi.mocked(reporter.captureMessage).mock.calls[0]
    expect(message).toContain('auth method: PAT')
    expect(level).toBe('warning')
    expect(ctx?.tags).toMatchObject({ component: 'repoSync', repoId: PAT_REPO.id, op: 'auth' })

    // The owner-facing syncError must still be persisted verbatim.
    expect(updateRepository).toHaveBeenCalledWith(PAT_REPO.id, {
      syncStatus: 'error',
      syncError: expect.stringContaining('auth method: PAT'),
    })
    expect(cloneRepo).not.toHaveBeenCalled()
  })

  it('reports the GitHub App variant of the missing-credential failure as a warning too', async () => {
    vi.mocked(getRepository).mockResolvedValue({ ...PAT_REPO, authMethod: 'githubapp' })
    vi.mocked(resolveRepoToken).mockResolvedValue(undefined)

    await new RepoSyncService(vi.fn()).syncRepo(PAT_REPO.id)

    expect(reporter.captureException).not.toHaveBeenCalled()
    const [message, level] = vi.mocked(reporter.captureMessage).mock.calls[0]
    expect(message).toContain('No GitHub App token could be minted')
    expect(level).toBe('warning')
  })

  it('still reports a thrown credential-resolution error as an exception', async () => {
    const boom = new Error('github app misconfigured')
    vi.mocked(resolveRepoToken).mockRejectedValue(boom)

    await new RepoSyncService(vi.fn()).syncRepo(PAT_REPO.id)

    expect(reporter.captureMessage).not.toHaveBeenCalled()
    expect(reporter.captureException).toHaveBeenCalledOnce()
    expect(reporter.captureException).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ tags: expect.objectContaining({ op: 'auth' }) })
    )
  })

  it('still reports an unexpected clone failure as an exception', async () => {
    vi.mocked(resolveRepoToken).mockResolvedValue('ghs_token')
    const boom = new Error('fatal: remote hung up unexpectedly')
    vi.mocked(cloneRepo).mockRejectedValue(boom)

    await new RepoSyncService(vi.fn()).syncRepo(PAT_REPO.id)

    expect(reporter.captureMessage).not.toHaveBeenCalled()
    expect(reporter.captureException).toHaveBeenCalledOnce()
    expect(reporter.captureException).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ tags: expect.objectContaining({ op: 'clone' }) })
    )
  })

  const AUTH_FAILED_PREFIX = 'Repository authentication failed.'
  const TERMINAL_AUTH_ERROR =
    'Repository authentication failed. Update the repository credentials, then retry synchronization.'

  it('persists a sanitized terminal auth error and reports one warning, not an exception', async () => {
    vi.mocked(resolveRepoToken).mockResolvedValue('ghs_token')
    vi.mocked(cloneRepo).mockRejectedValue(
      new Error('fatal: Authentication failed for https://github.com/acme/widgets.git')
    )

    await new RepoSyncService(vi.fn()).syncRepo(PAT_REPO.id)

    expect(reporter.captureException).not.toHaveBeenCalled()
    expect(reporter.captureMessage).toHaveBeenCalledOnce()
    const [message, level, ctx] = vi.mocked(reporter.captureMessage).mock.calls[0]
    expect(message.startsWith(AUTH_FAILED_PREFIX)).toBe(true)
    expect(message).not.toMatch(/ghs_|ghp_|token=|password/i)
    expect(level).toBe('warning')
    expect(ctx?.tags).toMatchObject({
      component: 'repoSync',
      repoId: PAT_REPO.id,
      op: 'clone',
      failureKind: 'authentication',
    })
    expect(ctx?.extra).toBeUndefined()

    expect(updateRepository).toHaveBeenCalledWith(PAT_REPO.id, {
      syncStatus: 'error',
      syncError: expect.stringMatching(/^Repository authentication failed\./),
    })
    const persisted = vi
      .mocked(updateRepository)
      .mock.calls.find(([, patch]) => patch.syncStatus === 'error')
    expect(String(persisted?.[1].syncError)).not.toMatch(/ghs_|ghp_|token=|password/i)
  })

  it('skips periodic sync when the repository already has a terminal auth error', async () => {
    vi.mocked(getRepository).mockResolvedValue({
      ...PAT_REPO,
      syncStatus: 'error',
      syncError: TERMINAL_AUTH_ERROR,
    })

    await new RepoSyncService(vi.fn()).syncRepo(PAT_REPO.id)

    expect(resolveRepoToken).not.toHaveBeenCalled()
    expect(cloneRepo).not.toHaveBeenCalled()
    expect(fetchRepo).not.toHaveBeenCalled()
    expect(reporter.captureException).not.toHaveBeenCalled()
    expect(reporter.captureMessage).not.toHaveBeenCalled()
  })

  it('bypasses terminal auth state when triggerSync is invoked', async () => {
    vi.mocked(getRepository).mockResolvedValue({
      ...PAT_REPO,
      syncStatus: 'error',
      syncError: TERMINAL_AUTH_ERROR,
    })
    vi.mocked(resolveRepoToken).mockResolvedValue('ghs_token')
    vi.mocked(cloneRepo).mockResolvedValue(undefined)

    await new RepoSyncService(vi.fn()).triggerSync(PAT_REPO.id)

    expect(resolveRepoToken).toHaveBeenCalledOnce()
    expect(cloneRepo).toHaveBeenCalledOnce()
  })

  it('keeps a timeout on the transient backoff path', async () => {
    vi.mocked(resolveRepoToken).mockResolvedValue('ghs_token')
    const boom = new Error('git fetch timed out after 600000ms')
    vi.mocked(cloneRepo).mockRejectedValue(boom)

    const service = new RepoSyncService(vi.fn())
    await service.syncRepo(PAT_REPO.id)

    expect(reporter.captureMessage).not.toHaveBeenCalled()
    expect(reporter.captureException).toHaveBeenCalledOnce()
    expect(reporter.captureException).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ tags: expect.objectContaining({ op: 'clone' }) })
    )
    expect(updateRepository).toHaveBeenCalledWith(PAT_REPO.id, {
      syncStatus: 'error',
      syncError: boom.message,
    })

    vi.mocked(resolveRepoToken).mockClear()
    vi.mocked(cloneRepo).mockClear()
    await service.syncRepo(PAT_REPO.id)

    expect(resolveRepoToken).not.toHaveBeenCalled()
    expect(cloneRepo).not.toHaveBeenCalled()
  })

  // A full data volume used to reach the owner as a raw git dump naming an
  // internal lock file, which says nothing about what to do next.
  it('replaces an out-of-space git failure with an actionable syncError', async () => {
    vi.mocked(resolveRepoToken).mockResolvedValue('ghs_token')
    vi.mocked(cloneRepo).mockRejectedValue(
      new Error(
        'git remote failed (exit 128): error: failed to write new configuration file ' +
          '/data/repos/repo-1/config.lock'
      )
    )

    await new RepoSyncService(vi.fn()).syncRepo(PAT_REPO.id)

    expect(updateRepository).toHaveBeenCalledWith(PAT_REPO.id, {
      syncStatus: 'error',
      syncError: expect.stringMatching(/not enough disk space to clone this repository/i),
    })
    // Reported as a message so every repo's out-of-space failure groups as one
    // issue, with the raw git text kept as context.
    expect(reporter.captureException).not.toHaveBeenCalled()
    const [message, level, ctx] = vi.mocked(reporter.captureMessage).mock.calls[0]
    expect(message).toMatch(/disk space/i)
    expect(level).toBe('error')
    expect(ctx?.extra?.gitError).toMatch(/failed to write new configuration file/)
  })

  // The clone can only be fetched for a branch it is told to fetch — see
  // branchFetchRefspec — so the repo's default branch has to reach fetchRepo.
  it('syncs an existing clone against the repo default branch', async () => {
    const clonePath = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-repo-sync-'))
    vi.mocked(getRepository).mockResolvedValue({ ...PAT_REPO, syncStatus: 'ready', clonePath })
    vi.mocked(resolveRepoToken).mockResolvedValue('ghs_token')

    try {
      await new RepoSyncService(vi.fn()).syncRepo(PAT_REPO.id)
    } finally {
      fs.rmSync(clonePath, { recursive: true, force: true })
    }

    expect(cloneRepo).not.toHaveBeenCalled()
    expect(fetchRepo).toHaveBeenCalledWith(
      clonePath,
      PAT_REPO.url,
      PAT_REPO.defaultBranch,
      'ghs_token'
    )
  })
})
