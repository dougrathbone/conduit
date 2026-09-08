import React from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleDashed,
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

const STATUS_STYLES: Record<
  ConfigHealthStatus,
  { label: string; text: string; border: string; background: string; dot: string }
> = {
  ok: {
    label: 'Ready',
    text: 'text-emerald-500',
    border: 'border-emerald-500/20',
    background: 'bg-emerald-500/[0.07]',
    dot: 'bg-emerald-500',
  },
  warn: {
    label: 'Action needed',
    text: 'text-amber-500',
    border: 'border-amber-500/25',
    background: 'bg-amber-500/[0.07]',
    dot: 'bg-amber-500',
  },
  error: {
    label: 'Not ready',
    text: 'text-red-400',
    border: 'border-red-500/25',
    background: 'bg-red-500/[0.07]',
    dot: 'bg-red-500',
  },
}

function StatusIcon({ status, pending }: { status: ConfigHealthStatus; pending?: boolean }) {
  if (pending) {
    return <Loader2 className="h-4 w-4 animate-spin text-[var(--text-secondary)] flex-shrink-0" />
  }
  if (status === 'ok') {
    return <Check className="h-4 w-4 text-emerald-500 flex-shrink-0" />
  }
  if (status === 'warn') {
    return <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
  }
  return <XCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
}

function HealthTile({
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
  const style = STATUS_STYLES[status]
  return (
    <div className={`min-w-0 rounded-xl border p-4 ${pending ? 'border-[var(--border)]' : style.border} ${pending ? 'bg-[var(--bg-primary)]/50' : style.background}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)]">
          {icon}
        </div>
        <span className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${pending ? 'text-[var(--text-secondary)]' : style.text}`}>
          <StatusIcon status={status} pending={pending} />
          {pending ? 'Checking' : style.label}
        </span>
      </div>
      <div className="mt-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
        <p className="mt-1 min-h-8 text-xs leading-4 text-[var(--text-secondary)]">
          {pending ? 'Checking configuration…' : message}
        </p>
        {children}
      </div>
    </div>
  )
}

function McpAttentionList({ items }: { items: McpAttentionItem[] }) {
  const setShowGlobalMcpManager = useUIStore((s) => s.setShowGlobalMcpManager)
  if (items.length === 0) return null
  return (
    <div className="mt-3 space-y-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]/70 px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${item.status === 'unauthorized' ? 'bg-amber-500' : 'bg-red-500'}`} />
            <span className="truncate text-xs font-medium text-[var(--text-primary)]">{item.name}</span>
          </div>
          <p className="mt-1 pl-3.5 text-[11px] leading-4 text-[var(--text-secondary)]">
            {item.status === 'unauthorized' ? 'Authentication required' : 'Connection failed'}
            {item.message ? ` · ${item.message}` : ''}
          </p>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs text-[var(--text-primary)]"
        onClick={() => setShowGlobalMcpManager(true)}
      >
        Review MCPs
        <ArrowRight className="h-3.5 w-3.5" />
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
    ? 'Checking the services Conduit relies on.'
    : health.isError
      ? `Couldn't load configuration health: ${health.error instanceof Error ? health.error.message : String(health.error)}`
      : data?.ok
        ? 'Everything Conduit needs is configured and responding.'
        : overall === 'warn'
          ? 'Conduit can run, but some connections need your attention.'
          : 'Resolve the items below before relying on Conduit.'

  const overallTitle = pending
    ? 'Checking Conduit'
    : health.isError
      ? 'Status unavailable'
      : data?.ok
        ? 'Conduit is ready'
        : overall === 'warn'
          ? 'Conduit needs attention'
          : 'Conduit is not fully ready'

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] shadow-sm">
      <div className="relative px-5 py-5 sm:px-6">
        <div className={`absolute inset-x-0 top-0 h-0.5 ${pending ? 'bg-[var(--border)]' : STATUS_STYLES[overall].dot}`} />
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3.5">
            <div className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl ${pending ? 'bg-[var(--bg-primary)] text-[var(--text-secondary)]' : STATUS_STYLES[overall].background + ' ' + STATUS_STYLES[overall].text}`}>
              {pending ? (
                <CircleDashed className="h-5 w-5 animate-spin" />
              ) : overall === 'ok' ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : overall === 'warn' ? (
                <AlertTriangle className="h-5 w-5" />
              ) : (
                <Activity className="h-5 w-5" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-[var(--text-primary)]">{overallTitle}</h2>
                {!pending && (
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLES[overall].background} ${STATUS_STYLES[overall].text}`}>
                    {STATUS_STYLES[overall].label}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">{overallCopy}</p>
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => health.refetch()}
            disabled={health.isFetching}
            className="flex-shrink-0 px-2 text-[var(--text-secondary)]"
            aria-label="Refresh Conduit status"
            title="Refresh Conduit status"
          >
            {health.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 border-t border-[var(--border)] bg-[var(--bg-primary)]/25 p-4 sm:grid-cols-3 sm:p-5">
        <HealthTile
          icon={<GitBranch className="h-4 w-4" />}
          title="Git"
          status={data?.git.status ?? 'ok'}
          message={data?.git.message ?? ''}
          pending={pending}
        />
        <HealthTile
          icon={<KeyRound className="h-4 w-4" />}
          title="Encryption"
          status={data?.encryption.status ?? 'ok'}
          message={data?.encryption.message ?? ''}
          pending={pending}
        />
        <HealthTile
          icon={<Plug className="h-4 w-4" />}
          title="MCP connections"
          status={data?.mcps.status ?? 'ok'}
          message={data?.mcps.message ?? ''}
          pending={pending}
        >
          {data && <McpAttentionList items={data.mcps.attention} />}
        </HealthTile>
      </div>
    </section>
  )
}
