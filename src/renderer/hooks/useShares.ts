import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { ShareableEntityType } from '@shared/types'

const SHARES_KEY = ['shares'] as const

function entityListKey(entityType: ShareableEntityType): string[] {
  switch (entityType) {
    case 'agent':
      return ['agents']
    case 'publishTarget':
      return ['publishTargets']
    case 'repository':
      return ['repos']
    case 'globalMcpServer':
      return ['globalMcps']
  }
}

export function useShares(entityType: ShareableEntityType, entityId: string) {
  return useQuery({
    queryKey: [...SHARES_KEY, entityType, entityId],
    queryFn: () => api.shares.list(entityType, entityId),
    enabled: Boolean(entityId),
  })
}

export function useCreateShare() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      entityType: ShareableEntityType
      entityId: string
      targetType: 'user' | 'group' | 'everyone'
      targetId?: string
    }) => api.shares.create(data),
    onSuccess: (_share, variables) => {
      queryClient.invalidateQueries({
        queryKey: [...SHARES_KEY, variables.entityType, variables.entityId],
      })
      queryClient.invalidateQueries({
        queryKey: entityListKey(variables.entityType),
      })
    },
  })
}

export function useDeleteShare() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (shareId: string) => api.shares.delete(shareId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SHARES_KEY })
    },
  })
}

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => api.users.list(),
  })
}

export function useSearchUsers(query: string) {
  return useQuery({
    queryKey: ['users', 'search', query],
    queryFn: () => api.users.search(query),
    enabled: query.length >= 2,
  })
}

export function useGroups() {
  return useQuery({
    queryKey: ['groups'],
    queryFn: () => api.groups.list(),
  })
}
