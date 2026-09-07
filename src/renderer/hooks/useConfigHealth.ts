import { useQuery } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { AppConfigHealth } from '@shared/types'

export const configHealthKey = ['maintenance', 'configHealth'] as const

/**
 * Instance configuration snapshot (git, encryption key, global MCP attention)
 * shown at the top of Settings.
 */
export function useConfigHealth() {
  return useQuery<AppConfigHealth>({
    queryKey: configHealthKey,
    queryFn: () => api.maintenance.configHealth(),
    staleTime: 15_000,
    retry: 0,
    refetchOnWindowFocus: 'always',
  })
}
