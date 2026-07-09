import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { RunnerTimeouts, RunnerType } from '@shared/types'

const timeoutsKey = ['runnerSettings', 'timeouts'] as const

/** The acting user's per-runner background-task timeout, in seconds (0 = indefinite). */
export function useRunnerTimeouts() {
  return useQuery<RunnerTimeouts>({
    queryKey: timeoutsKey,
    queryFn: () => api.runnerSettings.getTimeouts(),
  })
}

export function useSetRunnerTimeout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runner, seconds }: { runner: RunnerType; seconds: number }) =>
      api.runnerSettings.setTimeout(runner, seconds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: timeoutsKey })
    },
  })
}
