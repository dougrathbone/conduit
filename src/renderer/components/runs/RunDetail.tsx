import React from 'react'
import { Loader2 } from 'lucide-react'
import { TerminalPane } from '@renderer/components/layout/TerminalPane'
import { useRunLog } from '@renderer/hooks/useRuns'

interface RunDetailProps {
  runId: string
}

export function RunDetail({ runId }: RunDetailProps) {
  const { data: logEntries, isLoading, error } = useRunLog(runId)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-secondary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-red-400">
        Failed to load run log
      </div>
    )
  }

  return <TerminalPane logEntries={logEntries ?? []} />
}
