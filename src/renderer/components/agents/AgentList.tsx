import React from 'react'
import { Bot, Loader2 } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useAgents } from '@renderer/hooks/useAgents'
import { useUIStore } from '@renderer/store/ui'
import { StatusDot } from '@renderer/components/ui/badge'
import type { AgentConfig, RunStatus } from '@shared/types'

const runnerLabels: Record<AgentConfig['runner'], string> = {
  claude: 'Claude Code',
  amp: 'Amp',
  cursor: 'Cursor',
}

// Compact inline SVG logos for sidebar
function RunnerIcon({ runner, size = 11 }: { runner: AgentConfig['runner']; size?: number }) {
  if (runner === 'claude') return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M13.827 3.54L19.66 18h-3.133l-1.224-3.24H8.697L7.473 18H4.34L10.173 3.54h3.654zm-1.827 4.09L9.73 12.48h4.54L12 7.63z"/>
    </svg>
  )
  if (runner === 'amp') return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M13 2L4.5 13.5H11L10 22L19.5 10.5H13L13 2Z" strokeLinejoin="round"/>
    </svg>
  )
  // cursor
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M4 3l16 9-7.5 1.5L9 21z"/>
    </svg>
  )
}

interface AgentItemProps {
  agent: AgentConfig
  isSelected: boolean
  lastRunStatus?: RunStatus
  onClick: () => void
}

function AgentItem({ agent, isSelected, lastRunStatus, onClick }: AgentItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-2.5 rounded-lg flex items-start gap-2.5 transition-colors group',
        isSelected
          ? 'bg-[var(--accent)]/15 text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
      )}
    >
      <div className="mt-0.5 flex-shrink-0">
        {lastRunStatus ? (
          <StatusDot status={lastRunStatus} />
        ) : (
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--border)]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            'text-sm font-medium truncate',
            isSelected ? 'text-[var(--text-primary)]' : ''
          )}
        >
          {agent.name}
        </div>
        <div className="flex items-center gap-1 text-xs text-[var(--text-secondary)] mt-0.5">
          <RunnerIcon runner={agent.runner} />
          {runnerLabels[agent.runner]}
        </div>
      </div>
    </button>
  )
}

export function AgentList() {
  const { data: agents, isLoading, error } = useAgents()
  const { selectedAgentId, selectAgent } = useUIStore()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-[var(--text-secondary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-3 py-4 text-xs text-red-400">
        Failed to load agents
      </div>
    )
  }

  if (!agents || agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 px-4 text-center gap-3">
        <Bot className="h-8 w-8 text-[var(--border)]" />
        <p className="text-xs text-[var(--text-secondary)]">
          No agents yet. Create one to get started.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5 px-2">
      {agents.map((agent) => (
        <AgentItem
          key={agent.id}
          agent={agent}
          isSelected={agent.id === selectedAgentId}
          onClick={() => selectAgent(agent.id)}
        />
      ))}
    </div>
  )
}
