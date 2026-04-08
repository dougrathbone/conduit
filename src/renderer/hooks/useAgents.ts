import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { AgentConfig } from '@shared/types'

const AGENTS_KEY = ['agents'] as const

export function useAgents() {
  return useQuery({
    queryKey: AGENTS_KEY,
    queryFn: () => api.agents.list(),
  })
}

export function useAgent(id: string) {
  return useQuery({
    queryKey: ['agents', id],
    queryFn: () => api.agents.get(id),
    enabled: Boolean(id),
  })
}

export function useCreateAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>) =>
      api.agents.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AGENTS_KEY })
    },
  })
}

export function useUpdateAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string
      data: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>
    }) => api.agents.update(id, data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: AGENTS_KEY })
      queryClient.invalidateQueries({ queryKey: ['agents', updated.id] })
    },
  })
}

export function useDeleteAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.agents.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AGENTS_KEY })
    },
  })
}
