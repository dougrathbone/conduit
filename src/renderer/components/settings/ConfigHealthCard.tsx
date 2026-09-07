import React from 'react'
import {
  Activity,
  AlertTriangle,
  Check,
  GitBranch,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useConfigHealth } from '@renderer/hooks/useConfigHealth'
import { useUIStore } from '@renderer/store/ui'
import type { ConfigHealthStatus, McpAttentionItem } from '@shared/types'

function StatusIcon({ status, pending }: { status: ConfigHealthStatus; pending?: boolean }) {
  if (pending) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-secondary)] flex-shrink-0" />
  }
  if (status === 'ok') {
    return <Check className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
  }
  if (status === 'warn') {
    return <AlertTriangle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
  }
  return <XCircle className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />
}

function statusLabel(status: ConfigHealthStatus): { text: string; className: string } {
  if (status === 'ok') return { text: 'Healthy', className: 'text-green-500' }
  if (status === 'warn') return { text: 'Needs attention', className: 'text-amber-500' }
  return { text: 'Issue', className: 'text-red-400' }
}

function CheckRow({
  icon,
  title,
  status,
  message,
  pending,
  children,
}: {
  icon: React.ReactNode
  title: string
  status: ConfigHealthStatus
  message: string
  pending?: boolean
  children?: React.ReactNode
}) {
  const label = statusLabel(status)
  return (
    <div className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
      <div className="mt-0.5 text-[var(--text-secondary)]">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text-primary)]">{title}</span>
          <span className={`flex items-center gap-1 text-xs font-medium ${label.className}`}>
            <StatusIcon status={status} pending={pending} />
            {pending ? 'Checking…' : label.text}
          </span>
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-0.5">{pending ? 'Probing configuration…' : message}</p>
        {children}
      </div>
    </div>
  )
}

function McpAttentionList({ items }: { items: McpAttentionItem[] }) {
  const setShowGlobalMcpManager = useUIStore((s) => s.setShowGlobalMcpManager)
  if (items.length === 0) return null
  return (
    <div className="mt-2 space-y-1">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-start justify-between gap-2 text-xs rounded-md px-2 py-1.5 bg-[var(--bg-primary)]"
        >
          <div className="min-w-0">
            <span className="font-medium text-[var(--text-primary)]">{item.name}</span>
            <span className="text-[var(--text-secondary)]">
              {' '}
              · {item.status === 'unauthorized' ? 'Authentication required' : 'Unreachable'}
              {item.message ? ` — ${item.message}` : ''}
            </span>
          </div>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={() => setShowGlobalMcpManager(true)}
      >
        Open Global MCPs
      </Button>
    </div>
  )
}

export function ConfigHealthCard() {
  const health = useConfigHealth()
  const data = health.data
  const pending = health.isLoading && !data

  const overall: ConfigHealthStatus = health.isError
    ? 'error'
    : !data
      ? 'ok'
      : data.ok
        ? 'ok'
        : data.git.status === 'error' || data.encryption.status === 'error' || data.mcps.status === 'error'
          ? 'error'
          : 'warn'

  const overallCopy = pending
    ? 'Checking git, encryption, and MCP servers…'
    : health.isError
      ? `Couldn't load configuration health: ${health.error instanceof Error ? health.error.message : String(health.error)}`
      : data?.ok
        ? 'Git, encryption, and global MCP servers look good.'
        : 'One or more configuration checks need attention.'

  return (
    <div className="rounded-lg border border-[var(--border)] px-4 py-3.5" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <Activity className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)] mt-0.5" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">Configuration health</span>
              {(!pending && data) || health.isError ? (
                <span className={`text-xs font-medium ${statusLabel(overall).className}`}>
                  {statusLabel(overall).text}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">{overallCopy}</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => health.refetch()}
          disabled={health.isFetching}
          className="gap-1.5 flex-shrink-0"
        >
          {health.isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
      </div>

      <div className="mt-3 pt-2 border-t border-[var(--border)] divide-y divide-[var(--border)]">
        <CheckRow
          icon={<GitBranch className="h-4 w-4" />}
          title="Git"
          status={data?.git.status ?? 'ok'}
          message={data?.git.message ?? ''}
          pending={pending}
        />
        <CheckRow
          icon={<KeyRound className="h-4 w-4" />}
          title="Encryption key"
          status={data?.encryption.status ?? 'ok'}
          message={data?.encryption.message ?? ''}
          pending={pending}
        />
        <CheckRow
          icon={<Plug className="h-4 w-4" />}
          title="MCP servers"
          status={data?.mcps.status ?? 'ok'}
          message={data?.mcps.message ?? ''}
          pending={pending}
        >
          {data && <McpAttentionList items={data.mcps.attention} />}
        </CheckRow>
      </div>
    </div>
  )
}
