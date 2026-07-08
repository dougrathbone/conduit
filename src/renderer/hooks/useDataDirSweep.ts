import { useMutation } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { SweepResult } from '@shared/types'

/**
 * Trigger the data-directory sweeper on demand (Settings → "Clean up now").
 * Resolves with a summary of how many stale run artifacts were removed.
 */
export function useDataDirSweep() {
  return useMutation<SweepResult>({
    mutationFn: () => api.maintenance.sweep(),
  })
}
