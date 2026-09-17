import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { GlobalPromptComponent } from '@shared/types'

const KEY = ['globalPromptComponents'] as const

export function useGlobalPromptComponents() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.globalPromptComponents.list(),
  })
}

export function useCreateGlobalPromptComponent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Omit<GlobalPromptComponent, 'id' | 'createdAt' | 'updatedAt'>) =>
      api.globalPromptComponents.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY })
    },
  })
}

export function useUpdateGlobalPromptComponent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string
      data: Partial<Omit<GlobalPromptComponent, 'id' | 'createdAt' | 'updatedAt'>>
    }) => api.globalPromptComponents.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY })
    },
  })
}

export function useDeleteGlobalPromptComponent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.globalPromptComponents.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY })
    },
  })
}
