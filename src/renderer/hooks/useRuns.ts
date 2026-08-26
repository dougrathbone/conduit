import { useQuery, useMutation, useQueryClient, useIsMutating } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { api } from '@renderer/lib/ipc'
import { summarizeEvent } from '@shared/runEvents'
import type { RunEvent, ExecutionRun } from '@shared/types'

export function useRuns(agentId: string) {
  return useQuery({
    queryKey: ['runs', agentId],
    queryFn: () => api.runs.list(agentId),
    enabled: Boolean(agentId),
  })
}

/** Keyed by agent so an in-flight start can be observed per agent. */
const startRunMutationKey = (agentId: string) => ['runs', 'start', agentId]
const STOP_RUN_MUTATION_KEY = ['runs', 'stop']

export function useStartRun(agentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: startRunMutationKey(agentId),
    mutationFn: () => api.runs.start(agentId),
    onSuccess: (run) => {
      // Show the new run in the list immediately, before the refetch round-trip —
      // MainPanel derives the in-progress run (and the live pane) from this cache,
      // so an optimistic prepend makes both appear the instant Run is pressed.
      queryClient.setQueryData<ExecutionRun[]>(['runs', agentId], (old) =>
        old ? [run, ...old.filter((r) => r.id !== run.id)] : [run]
      )
      queryClient.invalidateQueries({ queryKey: ['runs', agentId] })
    },
  })
}

/**
 * Whether a start for this specific agent is in flight, read from the mutation
 * cache rather than from a `useStartRun` result. The Run button's component is
 * reused across agent switches, so a mutation observer's own `isPending` would
 * follow the user to the next agent and disable its Run button — for minutes,
 * since starting a run waits on the worker (a cold cloud worker is slow).
 */
export function useIsStartingRun(agentId: string): boolean {
  return useIsMutating({ mutationKey: startRunMutationKey(agentId) }) > 0
}

/** As above, for the Stop button — scoped to the run being stopped. */
export function useIsStoppingRun(runId: string | null): boolean {
  return (
    useIsMutating({
      mutationKey: STOP_RUN_MUTATION_KEY,
      predicate: (m) => m.state.variables === runId,
    }) > 0
  )
}

export function useStopRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: STOP_RUN_MUTATION_KEY,
    mutationFn: (runId: string) => api.runs.stop(runId),
    onSuccess: (_data, runId) => {
      // Invalidate all run lists — we don't know which agentId owns this run here
      queryClient.invalidateQueries({ queryKey: ['runs'] })
      queryClient.invalidateQueries({ queryKey: ['run-log', runId] })
    },
  })
}

export function useRunLog(runId: string, opts?: { live?: boolean }) {
  return useQuery({
    queryKey: ['run-log', runId],
    queryFn: () => api.runs.getLog(runId),
    enabled: Boolean(runId),
    // For a live run the file grows under us, so don't refetch on focus and treat
    // the snapshot as fresh — subsequent events arrive via the run:events stream.
    refetchOnWindowFocus: opts?.live ? false : undefined,
    staleTime: opts?.live ? Infinity : undefined,
  })
}

/**
 * Structured events for a run's log. Replay: the getLog snapshot. Live: the
 * snapshot plus events streamed after it, deduped by timestamp against the
 * snapshot so the join seam never double-counts. Old (terminal-format) runs
 * carry no events — `format` is 'terminal' and their raw entries are returned for
 * the xterm view.
 */
export function useRunEvents(runId: string, opts?: { live?: boolean }) {
  const live = opts?.live ?? false
  const { data: log, isLoading, error } = useRunLog(runId, { live })
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([])

  // Reset the live buffer whenever the run changes.
  useEffect(() => {
    setLiveEvents([])
  }, [runId])

  useEffect(() => {
    if (!live || !runId) return
    const unsub = api.onRunEvents((p) => {
      if (p.runId !== runId) return
      setLiveEvents((prev) => [...prev, ...p.events])
    })
    return () => unsub()
  }, [runId, live])

  const snapshotEvents = useMemo(
    () => (log?.format === 'events' ? log.events : []),
    [log]
  )
  const snapshotMaxT = useMemo(
    () => snapshotEvents.reduce((m, e) => Math.max(m, e.t), 0),
    [snapshotEvents]
  )
  const events = useMemo(() => {
    if (!live) return snapshotEvents
    return [...snapshotEvents, ...liveEvents.filter((e) => e.t > snapshotMaxT)]
  }, [live, snapshotEvents, liveEvents, snapshotMaxT])

  return {
    events,
    format: log?.format,
    terminalEntries: log?.format === 'terminal' ? log.entries : [],
    isLoading,
    error,
  }
}

/**
 * The latest activity label for a live run, derived from streamed events. Used by
 * the runs list, which shows many runs and doesn't hold each one's event stream.
 * Empty until the first meaningful event arrives.
 */
export function useLiveActivity(runId: string, enabled: boolean): string {
  const [activity, setActivity] = useState('')
  useEffect(() => {
    setActivity('')
  }, [runId])
  useEffect(() => {
    if (!enabled || !runId) return
    const unsub = api.onRunEvents((p) => {
      if (p.runId !== runId) return
      for (const ev of p.events) {
        const s = summarizeEvent(ev)
        if (s) setActivity(s)
      }
    })
    return () => unsub()
  }, [runId, enabled])
  return activity
}
