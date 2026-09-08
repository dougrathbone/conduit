import React, { useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
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
  { label: string; short: string; text: string; bg: string; dot: string }
> = {
  ok: {
    label: 'Ready',
    short: 'OK',
    text: 'text-emerald-500',
    bg: 'bg-emerald-500/10',
    dot: 'bg-emerald-500',
  },
  warn: {
    label: 'Needs attention',
    short: 'WARN',
    text: 'text-amber-500',
    bg: 'bg-amber-500/10',
    dot: 'bg-amber-500',
  },
  error: {
    label: 'Not ready',
    short: 'ERR',
    text: 'text-red-400',
    bg: 'bg-red-500/10',
    dot: 'bg-red-500',
  },
}

function StatusGlyph({ status, pending }: { status: ConfigHealthStatus; pending?: boolean }) {
  if (pending) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-secondary)]" aria-hidden />
  }
  if (status === 'ok') {
    return <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
  }
  if (status === 'warn') {
    return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-hidden />
  }
  return <XCircle className="h-3.5 w-3.5 text-red-400" aria-hidden />
}

function McpAttentionRows({ items }: { items: McpAttentionItem[] }) {
  const setShowGlobalMcpManager = useUIStore((s) => s.setShowGlobalMcpManager)
  if (items.length === 0) return null
  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-primary)]/40 px-3 py-2">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
        MCP attention
      </div>
      <ul className="divide-y divide-[var(--border)] rounded border border-[var(--border)] bg-[var(--bg-secondary)]">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 px-2.5 py-1.5">
            <span
              className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                item.status === 'unauthorized' ? 'bg-amber-500' : 'bg-red-500'
              }`}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-[var(--text-primary)]">{item.name}</div>
              <div className="text-[11px] leading-4 text-[var(--text-secondary)]">
                {item.status === 'unauthorized' ? 'Authentication required' : 'Connection failed'}
                {item.message ? ` · ${item.message}` : ''}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setShowGlobalMcpManager(true)}
        className="mt-1.5 text-[11px] font-medium text-[var(--accent)] hover:underline"
      >
        Open MCP manager
      </button>
    </div>
  )
}

interface CheckRowProps {
  icon: React.ReactNode
  name: string
  status: ConfigHealthStatus
  message: string
  pending?: boolean
  detail?: React.ReactNode
}

function CheckRow({ icon, name, status, message, pending, detail }: CheckRowProps) {
  const style = STATUS_STYLES[status]
  const hasDetail = Boolean(detail)
  const [open, setOpen] = useState(hasDetail)

  React.useEffect(() => {
    if (hasDetail) setOpen(true)
  }, [hasDetail])

  return (
    <>
      <tr className="border-t border-[var(--border)]">
        <td className="whitespace-nowrap px-3 py-2">
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
            <span className="text-[var(--text-secondary)]">{icon}</span>
            {name}
          </div>
        </td>
        <td className="px-3 py-2">
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              pending ? 'bg-[var(--bg-primary)] text-[var(--text-secondary)]' : `${style.bg} ${style.text}`
            }`}
          >
            <StatusGlyph status={status} pending={pending} />
            {pending ? '…' : style.short}
          </span>
        </td>
        <td className="px-3 py-2 text-[11px] leading-4 text-[var(--text-secondary)]">
          {pending ? 'Checking…' : message}
        </td>
        <td className="w-8 px-2 py-2 text-right">
          {hasDetail && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
              aria-expanded={open}
              aria-label={open ? `Hide ${name} details` : `Show ${name} details`}
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          )}
        </td>
      </tr>
      {hasDetail && open && (
        <tr>
          <td colSpan={4} className="p-0">
            {detail}
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * Compact control-center status strip: overall state plus a dense check table.
 * Preserves the same AppConfigHealth data and recheck / MCP actions as before.
 */
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

  const overallStyle = STATUS_STYLES[overall]
  const summary = pending
    ? 'Checking services…'
    : health.isError
      ? `Status unavailable: ${health.error instanceof Error ? health.error.message : String(health.error)}`
      : data?.ok
        ? 'All checks passing'
        : overall === 'warn'
          ? 'Runnable, with items to review'
          : 'Blocking issues detected'

  const mcpAttention = data?.mcps.attention ?? []

  return (
    <section
      id="status"
      aria-labelledby="settings-status-heading"
      className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border)] px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-bold uppercase tracking-wider ${
              pending ? 'bg-[var(--bg-primary)] text-[var(--text-secondary)]' : `${overallStyle.bg} ${overallStyle.text}`
            }`}
            role="status"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${pending ? 'bg-[var(--text-secondary)]' : overallStyle.dot}`}
            />
            {pending ? 'Checking' : overallStyle.label}
          </span>
          <div className="min-w-0">
            <h2 id="settings-status-heading" className="text-xs font-semibold text-[var(--text-primary)]">
              Instance health
            </h2>
            <p className="truncate text-[11px] text-[var(--text-secondary)]">{summary}</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => health.refetch()}
          disabled={health.isFetching}
          className="h-7 gap-1.5 border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-[11px] text-[var(--text-secondary)]"
          aria-label="Recheck Conduit status"
          title="Recheck Conduit status"
        >
          {health.isFetching ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Recheck
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] border-collapse text-left">
          <caption className="sr-only">Configuration health checks</caption>
          <thead>
            <tr className="bg-[var(--bg-primary)]/50 text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">
              <th scope="col" className="px-3 py-1.5 font-medium">
                Check
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                State
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Detail
              </th>
              <th scope="col" className="px-2 py-1.5 font-medium">
                <span className="sr-only">Expand</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <CheckRow
              icon={<GitBranch className="h-3.5 w-3.5" />}
              name="Git"
              status={data?.git.status ?? 'ok'}
              message={data?.git.message ?? ''}
              pending={pending}
            />
            <CheckRow
              icon={<KeyRound className="h-3.5 w-3.5" />}
              name="Encryption"
              status={data?.encryption.status ?? 'ok'}
              message={data?.encryption.message ?? ''}
              pending={pending}
            />
            <CheckRow
              icon={<Plug className="h-3.5 w-3.5" />}
              name="MCP"
              status={data?.mcps.status ?? 'ok'}
              message={data?.mcps.message ?? ''}
              pending={pending}
              detail={data && mcpAttention.length > 0 ? <McpAttentionRows items={mcpAttention} /> : undefined}
            />
          </tbody>
        </table>
      </div>
    </section>
  )
}
