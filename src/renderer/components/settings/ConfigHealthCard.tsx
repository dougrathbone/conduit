import React from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  GitBranch,
  KeyRound,
  Loader2,
  Plug,
  Radio,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useConfigHealth } from '@renderer/hooks/useConfigHealth'
import { useUIStore } from '@renderer/store/ui'
import type { ConfigHealthStatus, McpAttentionItem } from '@shared/types'

const STATUS_META: Record<
  ConfigHealthStatus,
  { label: string; text: string; chip: string; bar: string; glow: string }
> = {
  ok: {
    label: 'Nominal',
    text: 'text-emerald-500',
    chip: 'bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/30',
    bar: 'bg-emerald-500',
    glow: 'shadow-[inset_3px_0_0_0_rgb(16_185_129)]',
  },
  warn: {
    label: 'Degraded',
    text: 'text-amber-500',
    chip: 'bg-amber-500/15 text-amber-500 ring-1 ring-amber-500/30',
    bar: 'bg-amber-500',
    glow: 'shadow-[inset_3px_0_0_0_rgb(245_158_11)]',
  },
  error: {
    label: 'Critical',
    text: 'text-red-400',
    chip: 'bg-red-500/15 text-red-400 ring-1 ring-red-500/30',
    bar: 'bg-red-500',
    glow: 'shadow-[inset_3px_0_0_0_rgb(248_113_113)]',
  },
}

function StatusGlyph({ status, pending }: { status: ConfigHealthStatus; pending?: boolean }) {
  if (pending) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-secondary)]" />
  }
  if (status === 'ok') return <Check className="h-3.5 w-3.5 text-emerald-500" />
  if (status === 'warn') return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
  return <XCircle className="h-3.5 w-3.5 text-red-400" />
}

function MatrixRow({
  icon,
  code,
  title,
  status,
  message,
  pending,
  detail,
}: {
  icon: React.ReactNode
  code: string
  title: string
  status: ConfigHealthStatus
  message: string
  pending?: boolean
  detail?: React.ReactNode
}) {
  const meta = STATUS_META[status]
  return (
    <div
      className={`border-b border-[var(--border)] last:border-b-0 ${pending ? '' : meta.glow}`}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 sm:gap-4 sm:px-5">
        <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)]">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-secondary)]">
              {code}
            </span>
            <span className="text-sm font-medium text-[var(--text-primary)]">{title}</span>
          </div>
          <p className="mt-1 text-xs leading-4 text-[var(--text-secondary)]">
            {pending ? 'Probing…' : message}
          </p>
          {detail}
        </div>
        <span
          className={`mt-0.5 inline-flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${
            pending
              ? 'bg-[var(--bg-primary)] text-[var(--text-secondary)] ring-1 ring-[var(--border)]'
              : meta.chip
          }`}
        >
          <StatusGlyph status={status} pending={pending} />
          {pending ? 'Check' : meta.label}
        </span>
      </div>
    </div>
  )
}

function McpAttentionRail({ items }: { items: McpAttentionItem[] }) {
  const setShowGlobalMcpManager = useUIStore((s) => s.setShowGlobalMcpManager)
  if (items.length === 0) return null
  return (
    <div className="mt-2 space-y-1.5">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-start gap-2 rounded border border-[var(--border)] bg-[var(--bg-primary)]/80 px-2.5 py-1.5"
        >
          <span
            className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${
              item.status === 'unauthorized' ? 'bg-amber-500' : 'bg-red-500'
            }`}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-[var(--text-primary)]">{item.name}</div>
            <div className="text-[10px] leading-3.5 text-[var(--text-secondary)]">
              {item.status === 'unauthorized' ? 'Auth required' : 'Failed'}
              {item.message ? ` · ${item.message}` : ''}
            </div>
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setShowGlobalMcpManager(true)}
        className="inline-flex items-center gap-1 pt-0.5 text-[11px] font-medium text-[var(--text-primary)] hover:underline"
      >
        Open MCP console
        <ArrowRight className="h-3 w-3" />
      </button>
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

  const overallMeta = STATUS_META[overall]

  const headline = pending
    ? 'Systems check in progress'
    : health.isError
      ? 'Telemetry unavailable'
      : data?.ok
        ? 'All systems nominal'
        : overall === 'warn'
          ? 'Degraded — attention required'
          : 'Critical — not ready to run'

  const detail = pending
    ? 'Collecting Git, encryption, and MCP probes.'
    : health.isError
      ? health.error instanceof Error
        ? health.error.message
        : String(health.error)
      : data?.ok
        ? 'Instance dependencies are healthy. Agents can launch against this host.'
        : overall === 'warn'
          ? 'Conduit can still run, but one or more probes need operator action.'
          : 'Resolve critical probes before relying on managed runs.'

  const counts = {
    ok: [data?.git.status, data?.encryption.status, data?.mcps.status].filter((s) => s === 'ok').length,
    warn: [data?.git.status, data?.encryption.status, data?.mcps.status].filter((s) => s === 'warn').length,
    error: [data?.git.status, data?.encryption.status, data?.mcps.status].filter((s) => s === 'error').length,
  }

  return (
    <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-primary)]/40 px-4 py-2 sm:px-5">
        <div className="flex items-center gap-2">
          <Radio className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Ops · Readiness console
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => health.refetch()}
          disabled={health.isFetching}
          className="h-7 gap-1.5 px-2 text-[11px] text-[var(--text-secondary)]"
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

      <div className="grid lg:grid-cols-[minmax(240px,0.9fr)_minmax(0,1.4fr)]">
        {/* Left: overall readiness panel */}
        <aside className="relative flex flex-col justify-between gap-6 border-b border-[var(--border)] p-5 lg:border-b-0 lg:border-r lg:p-6">
          <div className={`absolute inset-y-0 left-0 w-1 ${pending ? 'bg-[var(--border)]' : overallMeta.bar}`} />
          <div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${
                  pending
                    ? 'bg-[var(--bg-primary)] text-[var(--text-secondary)] ring-1 ring-[var(--border)]'
                    : overallMeta.chip
                }`}
              >
                <StatusGlyph status={overall} pending={pending} />
                {pending ? 'Scanning' : overallMeta.label}
              </span>
            </div>
            <h2 className="mt-4 text-xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-2xl">
              {headline}
            </h2>
            <p className="mt-2 max-w-sm text-sm leading-5 text-[var(--text-secondary)]">{detail}</p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { key: 'ok', label: 'Nominal', value: pending ? '—' : String(counts.ok), tone: 'text-emerald-500' },
                { key: 'warn', label: 'Degraded', value: pending ? '—' : String(counts.warn), tone: 'text-amber-500' },
                { key: 'error', label: 'Critical', value: pending ? '—' : String(counts.error), tone: 'text-red-400' },
              ] as const
            ).map((cell) => (
              <div
                key={cell.key}
                className="rounded border border-[var(--border)] bg-[var(--bg-primary)]/60 px-2.5 py-2"
              >
                <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--text-secondary)]">
                  {cell.label}
                </div>
                <div className={`mt-1 text-lg font-semibold tabular-nums ${cell.tone}`}>{cell.value}</div>
              </div>
            ))}
          </div>
        </aside>

        {/* Right: health matrix / status rail */}
        <div className="min-w-0 bg-[var(--bg-primary)]/20">
          <div className="border-b border-[var(--border)] px-4 py-2 sm:px-5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-secondary)]">
              Probe matrix · Git · Encryption · MCP
            </span>
          </div>
          <MatrixRow
            icon={<GitBranch className="h-3.5 w-3.5" />}
            code="GIT"
            title="Git binary"
            status={data?.git.status ?? 'ok'}
            message={data?.git.message ?? ''}
            pending={pending}
          />
          <MatrixRow
            icon={<KeyRound className="h-3.5 w-3.5" />}
            code="ENC"
            title="Secret encryption"
            status={data?.encryption.status ?? 'ok'}
            message={data?.encryption.message ?? ''}
            pending={pending}
          />
          <MatrixRow
            icon={<Plug className="h-3.5 w-3.5" />}
            code="MCP"
            title="Global MCP links"
            status={data?.mcps.status ?? 'ok'}
            message={data?.mcps.message ?? ''}
            pending={pending}
            detail={data ? <McpAttentionRail items={data.mcps.attention} /> : undefined}
          />
        </div>
      </div>
    </section>
  )
}
