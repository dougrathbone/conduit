import React, { useEffect, useState } from 'react'
import { Play, Square, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useStartRun, useStopRun } from '@renderer/hooks/useRuns'
import { useUIStore } from '@renderer/store/ui'
import { formatDuration } from '@renderer/lib/utils'
import type { RunStatus } from '@shared/types'

interface RunControlsProps {
  agentId: string
  activeRunId: string | null
  activeRunStatus: RunStatus | null
  activeRunStartedAt: number | null
  onRunStarted?: () => void
}

export function RunControls({
  agentId,
  activeRunId,
  activeRunStatus,
  activeRunStartedAt,
  onRunStarted,
}: RunControlsProps) {
  const { setActiveRun } = useUIStore()
  const startRun = useStartRun(agentId)
  const stopRun = useStopRun()

  // Elapsed time counter for live runs
  const [elapsed, setElapsed] = useState<number>(0)

  useEffect(() => {
    if (activeRunStatus !== 'running' && activeRunStatus !== 'launched') {
      setElapsed(0)
      return
    }
    if (!activeRunStartedAt) return

    setElapsed(Date.now() - activeRunStartedAt)
    const interval = setInterval(() => {
      setElapsed(Date.now() - activeRunStartedAt)
    }, 1000)
    return () => clearInterval(interval)
  }, [activeRunStatus, activeRunStartedAt])

  const handleStart = async () => {
    try {
      const run = await startRun.mutateAsync()
      setActiveRun(run.id)
      onRunStarted?.()
    } catch (e) {
      console.error('Failed to start run:', e)
    }
  }

  const handleStop = async () => {
    if (!activeRunId) return
    try {
      await stopRun.mutateAsync(activeRunId)
    } catch (e) {
      console.error('Failed to stop run:', e)
    }
  }

  const isLive =
    activeRunStatus === 'running' || activeRunStatus === 'launched'
  const isStarting = startRun.isPending
  const isStopping = stopRun.isPending

  if (isLive) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-xs text-[var(--text-secondary)] font-mono tabular-nums">
          {formatDuration(elapsed)}
        </span>
        <div className="flex items-center gap-1.5 text-xs text-green-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Running</span>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={handleStop}
          disabled={isStopping}
          className="gap-1.5"
        >
          {isStopping ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Square className="h-3.5 w-3.5 fill-current" />
          )}
          Stop
        </Button>
      </div>
    )
  }

  const hasCompleted =
    activeRunStatus === 'completed' ||
    activeRunStatus === 'failed' ||
    activeRunStatus === 'stopped'

  return (
    <Button
      variant="default"
      size="sm"
      onClick={handleStart}
      disabled={isStarting}
      className="gap-1.5"
    >
      {isStarting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Play className="h-3.5 w-3.5 fill-current" />
      )}
      {hasCompleted ? 'Run Again' : 'Run'}
    </Button>
  )
}
