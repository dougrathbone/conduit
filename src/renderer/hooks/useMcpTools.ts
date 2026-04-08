import { useQuery } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { McpServerEntry } from '@shared/types'

export function useMcpTools(serverId: string, serverConfig: McpServerEntry) {
  return useQuery({
    queryKey: ['mcpTools', serverId],
    queryFn: () => api.globalMcps.listTools(serverConfig),
    staleTime: 60_000,
    gcTime: 120_000,
    retry: 0,
  })
}
