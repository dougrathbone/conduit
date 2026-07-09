import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { SweepResult } from '@shared/types'
import { storageUsageKey } from './useStorageUsage'

/**
 * Trigger the data-directory sweeper on demand (Settings → "Clean up now").
 * Resolves with a summary of how many stale run artifacts were removed, and
 * refreshes the storage-usage estimate so the displayed figures drop to reflect
 * the reclaimed space.
 */
export function useDataDirSweep() {
  const queryClient = useQueryClient()
  return useMutation<SweepResult>({
    mutationFn: () => api.maintenance.sweep(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: storageUsageKey })
    },
  })
}
