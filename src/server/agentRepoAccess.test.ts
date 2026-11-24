import { describe, expect, it } from 'vitest'
import { assertAgentRepositoryChangeAllowed } from './agentRepoAccess'

const visible = (...ids: string[]) => async (id: string) => ids.includes(id)

describe('assertAgentRepositoryChangeAllowed', () => {
  it('allows an unchanged repository the editor cannot see', async () => {
    await expect(assertAgentRepositoryChangeAllowed('hidden', 'hidden', visible())).resolves.toBeUndefined()
  })

  it('treats null, undefined and empty as the same "no repository"', async () => {
    await expect(assertAgentRepositoryChangeAllowed(null, undefined, visible())).resolves.toBeUndefined()
    await expect(assertAgentRepositoryChangeAllowed(undefined, '', visible())).resolves.toBeUndefined()
  })

  it('allows choosing a repository the editor can see', async () => {
    await expect(assertAgentRepositoryChangeAllowed(null, 'a', visible('a'))).resolves.toBeUndefined()
  })

  it('refuses choosing a repository the editor cannot see', async () => {
    await expect(assertAgentRepositoryChangeAllowed(null, 'hidden', visible('a'))).rejects.toThrow(
      'do not have access'
    )
  })

  it('refuses moving off a repository the editor cannot see', async () => {
    await expect(assertAgentRepositoryChangeAllowed('hidden', 'a', visible('a'))).rejects.toThrow(
      "isn't shared with you"
    )
    await expect(assertAgentRepositoryChangeAllowed('hidden', null, visible('a'))).rejects.toThrow(
      "isn't shared with you"
    )
  })

  it('allows swapping between two repositories the editor can see', async () => {
    await expect(assertAgentRepositoryChangeAllowed('a', 'b', visible('a', 'b'))).resolves.toBeUndefined()
  })
})
