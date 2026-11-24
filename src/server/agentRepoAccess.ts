import { ClientError } from './errors'

type CanAccessRepo = (repositoryId: string) => Promise<boolean>

function normalize(id: string | null | undefined): string | null {
  return id ? id : null
}

/**
 * Guard the repository an agent points at.
 *
 * - Pointing an agent at a repository requires access to that repository.
 * - Moving an agent off a repository requires access to it too, so someone the
 *   repo isn't shared with can't clear or swap a workspace they can't see.
 * - Sending the unchanged value is always fine (editors autosave the whole
 *   draft), so an agent keeps working with a repository its editor can't see.
 */
export async function assertAgentRepositoryChangeAllowed(
  current: string | null | undefined,
  next: string | null | undefined,
  canAccess: CanAccessRepo
): Promise<void> {
  const from = normalize(current)
  const to = normalize(next)
  if (from === to) return

  if (to && !(await canAccess(to))) {
    throw new ClientError('You do not have access to that repository')
  }
  if (from && !(await canAccess(from))) {
    throw new ClientError("This agent uses a repository that isn't shared with you, so it can't be changed")
  }
}
