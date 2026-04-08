import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { Trigger } from '@shared/types'

export function useTriggers(agentId: string) {
  return useQuery({
    queryKey: ['triggers', agentId],
    queryFn: () => api.triggers.list(agentId),
    enabled: !!agentId,
  })
}

export function useCreateTrigger() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>) =>
      api.triggers.create(data),
    onSuccess: (trigger) => {
      queryClient.invalidateQueries({ queryKey: ['triggers', trigger.agentId] })
    },
  })
}

export function useUpdateTrigger() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Omit<Trigger, 'id' | 'createdAt' | 'updatedAt'>> }) =>
      api.triggers.update(id, data),
    onSuccess: (trigger) => {
      queryClient.invalidateQueries({ queryKey: ['triggers', trigger.agentId] })
    },
  })
}

export function useDeleteTrigger(agentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.triggers.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['triggers', agentId] })
    },
  })
}
