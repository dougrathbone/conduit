import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api } from '@renderer/lib/ipc'

const tokenKey = (serverUrl: string) => ['mcpToken', serverUrl] as const

export function useMcpToken(serverUrl: string | undefined) {
  return useQuery({
    queryKey: tokenKey(serverUrl ?? ''),
    queryFn: () => api.mcpOAuth.getToken(serverUrl!),
    enabled: !!serverUrl,
  })
}

export function useStartMcpAuth() {
  return useMutation({
    mutationFn: ({ serverId, isGlobal }: { serverId: string; isGlobal: boolean }) =>
      api.mcpOAuth.startAuth(serverId, isGlobal),
  })
}

export function useRevokeMcpToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (serverUrl: string) => api.mcpOAuth.revokeToken(serverUrl),
    onSuccess: (_data, serverUrl) => {
      queryClient.invalidateQueries({ queryKey: tokenKey(serverUrl) })
    },
  })
}

/**
 * Subscribe to OAuth completion events from the main process.
 * Automatically invalidates the token query when a new token is saved.
 */
export function useMcpOAuthListener(
  onComplete?: (result: { serverUrl: string; success: boolean; error?: string }) => void
) {
  const queryClient = useQueryClient()

  useEffect(() => {
    return api.onMcpOAuthComplete((payload) => {
      // Invalidate the cached token so consumers re-fetch fresh data
      queryClient.invalidateQueries({ queryKey: tokenKey(payload.serverUrl) })
      onComplete?.(payload)
    })
  }, [queryClient, onComplete])
}
