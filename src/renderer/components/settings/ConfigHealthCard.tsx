import React from 'react'
import {
  AlertTriangle,
  ArrowRight,
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

const STATUS_STYLES: Record<
  ConfigHealthStatus,
  { label: string; text: string; track: string; fill: string }
> = {
  ok: {
    label: 'Done',
    text: 'text-emerald-600 dark:text-emerald-400',
    track: 'bg-emerald-500/15',
    fill: 'bg-emerald-500',
  },
  warn: {
    label: 'Needs a quick fix',
    text: 'text-amber-600 dark:text-amber-400',
    track: 'bg-amber-500/15',
    fill: 'bg-amber-500',
  },
  error: {
    label: 'Blocked',
    text: 'text-red-500',
    track: 'bg-red-500/15',
    fill: 'bg-red-500',
  },
}

function stepDone(status: ConfigHealthStatus | undefined, pending: boolean): boolean {
  return !pending && status === 'ok'
}

function nextActionCopy(
  kind: 'git' | 'encryption' | 'mcps',
  status: ConfigHealthStatus | undefined,
  message: string,
  pending: boolean,
  loadError?: string
): string {
  if (pending) return 'We are checking this for you…'
  if (loadError) return loadError
  if (status === 'ok') {
    if (kind === 'git') return 'Git is available for cloning and worktrees.'
    if (kind === 'encryption') return 'Secrets can be stored safely.'
    return 'Your enabled MCP connections look healthy.'
  }
  if (kind === 'git') {
    return message || 'Install Git on the Conduit host so agents can work with repositories.'
  }
  if (kind === 'encryption') {
    return (
      message ||
      'Set or repair CONDUIT_SECRET_KEY so Conduit can encrypt API keys and tokens.'
    )
  }
  return message || 'Open MCP settings and reconnect anything that needs attention.'
}

function StepMarker({
  index,
  done,
  pending,
  status,
}: {
  index: number
  done: boolean
  pending: boolean
  status: ConfigHealthStatus
}) {
  if (pending) {
    return (
      <span
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)]"
        aria-hidden
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </span>
    )
  }
  if (done) {
    return (
      <span
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white"
        aria-hidden
      >
        <Check className="h-4 w-4" strokeWidth={2.5} />
      </span>
    )
  }
  const tone =
    status === 'error'
      ? 'border-red-500/40 bg-red-500/10 text-red-500'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
  return (
    <span
      className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums ${tone}`}
      aria-hidden
    >
      {index}
    </span>
  )
}

function McpAttentionList({ items }: { items: McpAttentionItem[] }) {
  const setShowGlobalMcpManager = useUIStore((s) => s.setShowGlobalMcpManager)
  if (items.length === 0) return null
  return (
    <div className="mt-3 space-y-2">
      <ul className="space-y-1.5" aria-label="MCP connections that need attention">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-start gap-2 rounded-md bg-[var(--bg-primary)]/80 px-3 py-2 text-xs"
          >
            {item.status === 'unauthorized' ? (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-500" aria-hidden />
            ) : (
              <XCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-400" aria-hidden />
            )}
            <div className="min-w-0">
              <div className="font-medium text-[var(--text-primary)]">{item.name}</div>
              <p className="mt-0.5 text-[11px] leading-4 text-[var(--text-secondary)]">
                {item.status === 'unauthorized'
                  ? 'Sign in again to reconnect this tool.'
                  : 'This connection failed — check the server URL or credentials.'}
                {item.message ? ` ${item.message}` : ''}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 text-xs"
        onClick={() => setShowGlobalMcpManager(true)}
      >
        Review MCP connections
        <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

function ChecklistStep({
  index,
  icon,
  title,
  plainWhy,
  status,
  pending,
  nextAction,
  isLast,
  children,
}: {
  index: number
  icon: React.ReactNode
  title: string
  plainWhy: string
  status: ConfigHealthStatus
  pending?: boolean
  nextAction: string
  isLast?: boolean
  children?: React.ReactNode
}) {
  const done = stepDone(status, !!pending)
  const style = STATUS_STYLES[status]
  const stateLabel = pending ? 'Checking' : style.label

  return (
    <li className="relative flex gap-4">
      {!isLast && (
        <span
          className="absolute left-4 top-8 bottom-0 w-px -translate-x-1/2 bg-[var(--border)]"
          aria-hidden
        />
      )}
      <StepMarker index={index} done={done} pending={!!pending} status={status} />
      <div
        className={`mb-3 min-w-0 flex-1 rounded-lg border px-4 py-3.5 ${
          pending
            ? 'border-[var(--border)] bg-[var(--bg-secondary)]'
            : done
              ? 'border-[var(--border)] bg-[var(--bg-secondary)]'
              : status === 'error'
                ? 'border-red-500/25 bg-red-500/[0.04]'
                : 'border-amber-500/25 bg-amber-500/[0.04]'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 text-[var(--text-secondary)]" aria-hidden>
              {icon}
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                <span className="sr-only">Step {index}: </span>
                {title}
              </h3>
              <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{plainWhy}</p>
            </div>
          </div>
          <span
            className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${
              pending ? 'bg-[var(--bg-primary)] text-[var(--text-secondary)]' : `${style.track} ${style.text}`
            }`}
          >
            {stateLabel}
          </span>
        </div>
        <p className="mt-2.5 text-sm leading-5 text-[var(--text-primary)]">
          <span className="font-medium">{done ? 'You’re set — ' : 'Next: '}</span>
          {nextAction}
        </p>
        {children}
      </div>
    </li>
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

  const checks = [
    { key: 'git' as const, status: data?.git.status },
    { key: 'encryption' as const, status: data?.encryption.status },
    { key: 'mcps' as const, status: data?.mcps.status },
  ]
  const completedCount = pending
    ? 0
    : health.isError
      ? 0
      : checks.filter((c) => c.status === 'ok').length
  const totalCount = checks.length
  const progressPct = pending ? 12 : Math.round((completedCount / totalCount) * 100)

  const overallTitle = pending
    ? 'Checking your setup…'
    : health.isError
      ? 'We couldn’t check your setup'
      : data?.ok
        ? 'Foundation setup complete'
        : overall === 'warn'
          ? 'A few setup steps still need you'
          : 'Finish these steps before you rely on Conduit'

  const overallCopy = pending
    ? 'Hang tight while we confirm Git, encryption, and MCP connections.'
    : health.isError
      ? `Something went wrong loading status: ${health.error instanceof Error ? health.error.message : String(health.error)}`
      : data?.ok
        ? 'The core pieces Conduit needs are in place. Next, connect the agent CLIs you plan to use.'
        : 'Work through the checklist below — each item explains what to do in plain language.'

  const loadError =
    health.isError
      ? `Couldn't load this check: ${health.error instanceof Error ? health.error.message : String(health.error)}`
      : undefined

  return (
    <section
      className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
      aria-labelledby="setup-progress-heading"
    >
      <div className="border-b border-[var(--border)] px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
              Setup checklist
            </p>
            <h2
              id="setup-progress-heading"
              className="mt-1.5 text-lg font-semibold tracking-tight text-[var(--text-primary)]"
            >
              {overallTitle}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">{overallCopy}</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => health.refetch()}
            disabled={health.isFetching}
            className="min-w-[5.5rem] flex-shrink-0 gap-2 self-start border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-[var(--text-secondary)]"
            aria-label="Recheck Conduit status"
            title="Recheck Conduit status"
          >
            {health.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span>Recheck</span>
          </Button>
        </div>

        <div className="mt-5" role="status" aria-live="polite">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {pending
                ? 'Progress pending…'
                : health.isError
                  ? 'Progress unavailable'
                  : `${completedCount} of ${totalCount} foundation checks ready`}
            </span>
            {!pending && !health.isError && (
              <span className={`text-xs font-medium ${STATUS_STYLES[overall].text}`}>
                {STATUS_STYLES[overall].label}
              </span>
            )}
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-[var(--bg-primary)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPct}
            aria-label="Foundation setup progress"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ease-out ${
                pending
                  ? 'bg-[var(--text-secondary)]/40'
                  : health.isError
                    ? STATUS_STYLES.error.fill
                    : STATUS_STYLES[overall].fill
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>

      <ol className="space-y-0 px-5 py-5 sm:px-6">
        <ChecklistStep
          index={1}
          icon={<GitBranch className="h-4 w-4" />}
          title="Git on the server"
          plainWhy="Needed so Conduit can clone repos and create isolated workspaces for each run."
          status={data?.git.status ?? (health.isError ? 'error' : 'ok')}
          pending={pending}
          nextAction={nextActionCopy('git', data?.git.status, data?.git.message ?? '', pending, loadError)}
        />
        <ChecklistStep
          index={2}
          icon={<KeyRound className="h-4 w-4" />}
          title="Secret encryption"
          plainWhy="Protects API keys, GitHub App keys, and MCP tokens stored in Conduit."
          status={data?.encryption.status ?? (health.isError ? 'error' : 'ok')}
          pending={pending}
          nextAction={nextActionCopy(
            'encryption',
            data?.encryption.status,
            data?.encryption.message ?? '',
            pending,
            loadError
          )}
        />
        <ChecklistStep
          index={3}
          icon={<Plug className="h-4 w-4" />}
          title="MCP tool connections"
          plainWhy="Optional tools your agents can call. Skip if you are not using global MCPs yet."
          status={data?.mcps.status ?? (health.isError ? 'error' : 'ok')}
          pending={pending}
          nextAction={nextActionCopy('mcps', data?.mcps.status, data?.mcps.message ?? '', pending, loadError)}
          isLast
        >
          {data && <McpAttentionList items={data.mcps.attention} />}
        </ChecklistStep>
      </ol>
    </section>
  )
}
