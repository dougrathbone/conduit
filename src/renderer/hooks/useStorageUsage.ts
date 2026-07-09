import { useQuery } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'
import type { StorageUsage } from '@shared/types'

/** Query key for the data-directory storage usage estimate. */
export const storageUsageKey = ['maintenance', 'storageUsage'] as const

/**
 * Current data-directory disk usage (total + reclaimable), shown on the Settings
 * screen next to the cleanup button. The server walks the data dir on each call,
 * so we keep it fresh-enough (short stale window) without re-walking on every
 * focus. `useDataDirSweep` invalidates this key after a sweep so the numbers drop
 * once space is reclaimed.
 */
export function useStorageUsage() {
  return useQuery<StorageUsage>({
    queryKey: storageUsageKey,
    queryFn: () => api.maintenance.storageUsage(),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  })
}
