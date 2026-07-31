import type { ResolvedShare, Share } from '../shared/types'
import { getUser } from '../main/db/queries/users'
import { getGroup } from '../main/db/queries/groups'
import { isAuthEnabled } from './auth/config'
import { resolveOktaUserName, resolveOktaGroupName } from './auth/okta'

interface ResolvedTarget {
  name: string
  email: string | null
}

/**
 * Enrich shares with friendly target names. Local DB wins; targets that
 * aren't known locally (e.g. an Okta user shared with before their first
 * login) fall back to the Okta Management API when auth + API token are
 * configured.
 */
export async function resolveShareNames(shares: Share[]): Promise<ResolvedShare[]> {
  const userIds = new Set<string>()
  const groupIds = new Set<string>()
  for (const share of shares) {
    if (!share.targetId) continue
    if (share.targetType === 'user') userIds.add(share.targetId)
    if (share.targetType === 'group') groupIds.add(share.targetId)
  }

  const resolved = new Map<string, ResolvedTarget>()

  await Promise.all([
    ...[...userIds].map(async (id) => {
      const local = await getUser(id)
      if (local) {
        resolved.set(id, { name: local.name, email: local.email })
        return
      }
      if (isAuthEnabled()) {
        const remote = await resolveOktaUserName(id)
        if (remote) resolved.set(id, { name: remote.name, email: remote.email ?? null })
      }
    }),
    ...[...groupIds].map(async (id) => {
      const local = await getGroup(id)
      if (local) {
        resolved.set(id, { name: local.name, email: null })
        return
      }
      if (isAuthEnabled()) {
        const remote = await resolveOktaGroupName(id)
        if (remote) resolved.set(id, { name: remote.name, email: null })
      }
    }),
  ])

  return shares.map((share) => {
    if (share.targetType === 'everyone') {
      return { ...share, targetName: 'Everyone', targetEmail: null }
    }
    const target = share.targetId ? resolved.get(share.targetId) : undefined
    return {
      ...share,
      targetName: target?.name ?? null,
      targetEmail: target?.email ?? null,
    }
  })
}
