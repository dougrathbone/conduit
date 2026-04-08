import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'

export function useSaveGist() {
  return useMutation({
    mutationFn: ({ content, gistId }: { content: string; gistId?: string }) =>
      api.gist.save(content, gistId),
  })
}

export function useLoadGist() {
  return useMutation({
    mutationFn: (gistId: string) => api.gist.load(gistId),
  })
}

export function useListGists(enabled: boolean) {
  return useQuery({
    queryKey: ['gists'],
    queryFn: () => api.gist.list(),
    enabled,
    staleTime: 30_000,
  })
}
