import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { GlobalMcpServer } from '@shared/types'

const GLOBAL_MCPS_KEY = ['globalMcps'] as const

export function useGlobalMcps() {
  return useQuery({
    queryKey: GLOBAL_MCPS_KEY,
    queryFn: () => api.globalMcps.list(),
  })
}

export function useCreateGlobalMcp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>) =>
      api.globalMcps.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: GLOBAL_MCPS_KEY })
    },
  })
}

export function useUpdateGlobalMcp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string
      data: Partial<Omit<GlobalMcpServer, 'id' | 'createdAt' | 'updatedAt'>>
    }) => api.globalMcps.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: GLOBAL_MCPS_KEY })
    },
  })
}

export function useDeleteGlobalMcp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.globalMcps.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: GLOBAL_MCPS_KEY })
    },
  })
}
