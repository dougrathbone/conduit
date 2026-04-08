import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'

export function useRuns(agentId: string) {
  return useQuery({
    queryKey: ['runs', agentId],
    queryFn: () => api.runs.list(agentId),
    enabled: Boolean(agentId),
  })
}

export function useStartRun(agentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.runs.start(agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['runs', agentId] })
    },
  })
}

export function useStopRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => api.runs.stop(runId),
    onSuccess: (_data, runId) => {
      // Invalidate all run lists — we don't know which agentId owns this run here
      queryClient.invalidateQueries({ queryKey: ['runs'] })
      queryClient.invalidateQueries({ queryKey: ['run-log', runId] })
    },
  })
}

export function useRunLog(runId: string) {
  return useQuery({
    queryKey: ['run-log', runId],
    queryFn: () => api.runs.getLog(runId),
    enabled: Boolean(runId),
  })
}
