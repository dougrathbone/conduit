import React from 'react'
import { cn } from '@renderer/lib/utils'
import type { RunStatus } from '@shared/types'

interface BadgeProps {
  status: RunStatus
  className?: string
}

const statusConfig: Record<RunStatus, { label: string; className: string; pulse?: boolean }> = {
  running: {
    label: 'Running',
    className: 'bg-green-500/20 text-green-400 border border-green-500/30',
    pulse: true,
  },
  completed: {
    label: 'Completed',
    className: 'bg-green-500/10 text-green-500 border border-green-500/20',
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-500/10 text-red-400 border border-red-500/20',
  },
  stopped: {
    label: 'Stopped',
    className: 'bg-neutral-500/10 text-neutral-400 border border-neutral-500/20',
  },
  launched: {
    label: 'Launched',
    className: 'bg-blue-500/10 text-blue-400 border border-blue-500/20',
  },
}

export function StatusBadge({ status, className }: BadgeProps) {
  const config = statusConfig[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        config.className,
        className
      )}
    >
      {config.pulse ? (
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400" />
        </span>
      ) : (
        <span
          className={cn('h-1.5 w-1.5 rounded-full', {
            'bg-green-500': status === 'completed',
            'bg-red-400': status === 'failed',
            'bg-neutral-400': status === 'stopped',
            'bg-blue-400': status === 'launched',
          })}
        />
      )}
      {config.label}
    </span>
  )
}

interface StatusDotProps {
  status: RunStatus
  className?: string
}

export function StatusDot({ status, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 rounded-full flex-shrink-0',
        {
          'bg-green-400 animate-pulse': status === 'running',
          'bg-green-500': status === 'completed',
          'bg-red-400': status === 'failed',
          'bg-neutral-400': status === 'stopped',
          'bg-blue-400': status === 'launched',
        },
        className
      )}
    />
  )
}
