import { describe, it, expect, vi, beforeEach } from 'vitest'
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
vi.mock('./gitOps', () => ({
  cloneRepo: vi.fn(),
  fetchRepo: vi.fn(),
}))

import { RepoSyncService } from './repoSync'
import { reporter } from './observability'
import { getRepository, updateRepository } from '../main/db/queries/repositories'
import { resolveRepoToken } from './githubApp'
import { cloneRepo } from './gitOps'

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
    const boom = new Error('fatal: authentication failed')
    vi.mocked(cloneRepo).mockRejectedValue(boom)

    await new RepoSyncService(vi.fn()).syncRepo(PAT_REPO.id)

    expect(reporter.captureMessage).not.toHaveBeenCalled()
    expect(reporter.captureException).toHaveBeenCalledOnce()
    expect(reporter.captureException).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ tags: expect.objectContaining({ op: 'clone' }) })
    )
  })
})
