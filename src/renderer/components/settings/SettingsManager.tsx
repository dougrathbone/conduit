import React, { useEffect, useState } from 'react'
import {
  Check,
  HardDrive,
  KeyRound,
  Loader2,
  ScrollText,
  Settings2,
  Timer,
  Trash2,
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useAgentCredentialStatus, useSetAgentCredential } from '@renderer/hooks/useAgentCredentials'
import { useRunnerTimeouts, useSetRunnerTimeout } from '@renderer/hooks/useRunnerTimeouts'
import { useDataDirSweep } from '@renderer/hooks/useDataDirSweep'
import { useStorageUsage } from '@renderer/hooks/useStorageUsage'
import { cn, formatBytes } from '@renderer/lib/utils'
import type { RunnerType, SweepResult } from '@shared/types'
import { PromptComponentManager } from './PromptComponentManager'
import { ConfigHealthCard } from './ConfigHealthCard'

interface RunnerMeta {
  runner: RunnerType
  label: string
  envVar: string
  hint: string
}

const RUNNERS: RunnerMeta[] = [
  {
    runner: 'claude',
    label: 'Claude Code',
    envVar: 'ANTHROPIC_API_KEY',
    hint: 'Anthropic API key for the Claude Code CLI.',
  },
  {
    runner: 'amp',
    label: 'Amp',
    envVar: 'AMP_API_KEY',
    hint: 'Sourcegraph Amp API key for the Amp CLI.',
  },
  {
    runner: 'cursor',
    label: 'Cursor',
    envVar: 'CURSOR_API_KEY',
    hint: 'Cursor API key for the cursor-agent CLI.',
  },
]

const NAV_ITEMS = [
  { id: 'status', label: 'Status', icon: Settings2 },
  { id: 'agents', label: 'Agents', icon: KeyRound },
  { id: 'defaults', label: 'Defaults', icon: ScrollText },
  { id: 'storage', label: 'Storage', icon: HardDrive },
] as const

const NAV_IDS = NAV_ITEMS.map((n) => n.id)

function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function useActiveSection() {
  const [active, setActive] = useState<(typeof NAV_IDS)[number]>(NAV_IDS[0])

  useEffect(() => {
    const elements = NAV_IDS
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => Boolean(el))
    if (elements.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)
        const id = visible[0]?.target.id
        if (id && (NAV_IDS as readonly string[]).includes(id)) {
          setActive(id as (typeof NAV_IDS)[number])
        }
      },
      { rootMargin: '-15% 0px -55% 0px', threshold: [0.1, 0.35, 0.6] }
    )

    for (const el of elements) observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return active
}

/**
 * Dense row for one agent harness: credential + timeout in a single line group.
 */
function RunnerSettingsRow({
  meta,
  configured,
  seconds,
}: {
  meta: RunnerMeta
  configured: boolean
  seconds: number
}) {
  const [keyValue, setKeyValue] = useState('')
  const setCredential = useSetAgentCredential()
  const credBusy = setCredential.isPending

  const handleSaveKey = async () => {
    if (!keyValue.trim()) return
    try {
      await setCredential.mutateAsync({ runner: meta.runner, value: keyValue })
      setKeyValue('')
    } catch (err) {
      console.error('Failed to save credential:', err)
    }
  }

  const handleClearKey = async () => {
    try {
      await setCredential.mutateAsync({ runner: meta.runner, value: '' })
      setKeyValue('')
    } catch (err) {
      console.error('Failed to clear credential:', err)
    }
  }

  const [timeoutValue, setTimeoutValue] = useState(String(seconds))
  const saveTimeout = useSetRunnerTimeout()
  const timeoutBusy = saveTimeout.isPending
  const timeoutSupported = meta.runner === 'claude'

  useEffect(() => {
    setTimeoutValue(String(seconds))
  }, [seconds])

  const timeoutDirty = String(seconds) !== timeoutValue.trim()

  const handleSaveTimeout = async () => {
    const n = Math.max(0, Math.floor(Number(timeoutValue) || 0))
    try {
      await saveTimeout.mutateAsync({ runner: meta.runner, seconds: n })
      setTimeoutValue(String(n))
    } catch (err) {
      console.error('Failed to save timeout:', err)
    }
  }

  return (
    <div className="grid gap-3 border-t border-[var(--border)] px-3 py-3 lg:grid-cols-[11rem_minmax(0,1fr)_10.5rem] lg:items-start lg:gap-4">
      <div className="min-w-0 pt-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">{meta.label}</span>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              configured
                ? 'bg-emerald-500/10 text-emerald-500'
                : 'bg-[var(--bg-primary)] text-[var(--text-secondary)]'
            )}
          >
            {configured && <Check className="h-3 w-3" />}
            {configured ? 'On' : 'Off'}
          </span>
        </div>
        <code className="mt-1 block truncate text-[10px] text-[var(--text-secondary)]">{meta.envVar}</code>
        <p className="mt-1 text-[11px] leading-4 text-[var(--text-secondary)]">{meta.hint}</p>
      </div>

      <div className="min-w-0">
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
          API key
        </label>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveKey()
            }}
            placeholder={configured ? 'Replace key…' : 'Paste key…'}
            autoComplete="off"
            className="h-8 flex-1 text-sm"
          />
          <Button
            size="sm"
            onClick={handleSaveKey}
            disabled={!keyValue.trim() || credBusy}
            className="h-8 gap-1.5 px-2.5"
          >
            {credBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        </div>
        {configured && (
          <button
            type="button"
            onClick={handleClearKey}
            disabled={credBusy}
            className="mt-1 text-[11px] text-[var(--text-secondary)] hover:text-red-400 disabled:opacity-50"
          >
            Remove key
          </button>
        )}
      </div>

      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-1.5">
          <Timer className="h-3 w-3 text-[var(--text-secondary)]" aria-hidden />
          <label className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
            Wait (sec)
          </label>
          {!timeoutSupported && (
            <span className="rounded bg-[var(--bg-primary)] px-1 py-0.5 text-[9px] uppercase tracking-wide text-[var(--text-secondary)]">
              N/A
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            value={timeoutValue}
            onChange={(e) => setTimeoutValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveTimeout()
            }}
            className="h-8 w-20"
            aria-label={`${meta.label} background wait seconds`}
            title={
              timeoutSupported
                ? 'How long to wait for background work. Use 0 for no limit.'
                : 'Saved for future CLI support.'
            }
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleSaveTimeout}
            disabled={timeoutBusy || !timeoutDirty}
            className="h-8 gap-1.5 px-2.5"
          >
            {timeoutBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Set
          </Button>
        </div>
      </div>
    </div>
  )
}

function sweepSummary(r: SweepResult): string {
  const parts: string[] = []
  if (r.worktreesRemoved) parts.push(`${r.worktreesRemoved} worktree${r.worktreesRemoved === 1 ? '' : 's'}`)
  if (r.workspacesRemoved) parts.push(`${r.workspacesRemoved} workspace${r.workspacesRemoved === 1 ? '' : 's'}`)
  if (r.mcpConfigsRemoved) parts.push(`${r.mcpConfigsRemoved} MCP config${r.mcpConfigsRemoved === 1 ? '' : 's'}`)
  if (r.logsRemoved) parts.push(`${r.logsRemoved} old log${r.logsRemoved === 1 ? '' : 's'}`)
  if (r.bareClonesRemoved) parts.push(`${r.bareClonesRemoved} orphaned clone${r.bareClonesRemoved === 1 ? '' : 's'}`)
  if (r.cloningTmpRemoved) parts.push(`${r.cloningTmpRemoved} clone temp${r.cloningTmpRemoved === 1 ? '' : 's'}`)
  const removed = parts.length ? `Removed ${parts.join(', ')}.` : ''
  const compacted = r.reposCompacted ? `Compacted ${r.reposCompacted} clone${r.reposCompacted === 1 ? '' : 's'}.` : ''
  return [removed, compacted].filter(Boolean).join(' ') || 'Nothing to clean up — already tidy.'
}

function StorageUsageSummary() {
  const usage = useStorageUsage()

  if (usage.isLoading) {
    return (
      <div className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Calculating…
      </div>
    )
  }

  if (usage.isError || !usage.data) {
    return <div className="text-xs text-[var(--text-secondary)]">Couldn't measure storage usage.</div>
  }

  const { totalBytes, reclaimableBytes } = usage.data
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">
          {formatBytes(totalBytes)}
        </span>
        <span className="text-xs text-[var(--text-secondary)]">in use</span>
        {usage.isFetching && <Loader2 className="h-3 w-3 animate-spin text-[var(--text-secondary)]" />}
      </div>
      {reclaimableBytes > 0 && (
        <span className="text-xs text-[var(--text-secondary)]">
          {formatBytes(reclaimableBytes)} reclaimable
        </span>
      )}
    </div>
  )
}

function StorageMaintenancePanel() {
  const sweep = useDataDirSweep()

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
      <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold text-[var(--text-primary)]">Data directory</div>
          <StorageUsageSummary />
          <p className="max-w-2xl text-[11px] leading-4 text-[var(--text-secondary)]">
            Reclaim worktrees, temp workspaces, and MCP files from finished runs. Active runs are never
            touched.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending}
          className="h-8 flex-shrink-0 gap-1.5"
        >
          {sweep.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Clean up
        </Button>
      </div>
      {sweep.data && !sweep.isPending && (
        <p className="border-t border-[var(--border)] px-3 py-2 text-xs text-green-500">
          {sweepSummary(sweep.data)}
        </p>
      )}
      {sweep.isError && (
        <p className="border-t border-[var(--border)] px-3 py-2 text-xs text-red-400">
          Cleanup failed: {sweep.error instanceof Error ? sweep.error.message : String(sweep.error)}
        </p>
      )}
    </div>
  )
}

function SectionChrome({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-3 space-y-3">
      <header className="border-b border-[var(--border)] pb-2">
        <h2 id={`${id}-heading`} className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">
          {title}
        </h2>
        <p className="mt-0.5 text-[11px] leading-4 text-[var(--text-secondary)]">{description}</p>
      </header>
      {children}
    </section>
  )
}

export function SettingsManager() {
  const { data: status } = useAgentCredentialStatus()
  const { data: timeouts } = useRunnerTimeouts()
  const active = useActiveSection()

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      <div className="flex-shrink-0 border-b border-[var(--border)] bg-[var(--bg-secondary)]/80">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">Settings</h1>
            <p className="text-[11px] text-[var(--text-secondary)]">
              Control center · credentials, defaults, and instance health
            </p>
          </div>
          <span className="hidden rounded border border-[var(--border)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] sm:inline">
            Ops view
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-4 pb-16 sm:px-6 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8 lg:py-5">
          {/* Sticky in-page section nav */}
          <nav
            aria-label="Settings sections"
            className="lg:sticky lg:top-3 lg:self-start"
          >
            <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
              {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
                const isActive = active === id
                return (
                  <li key={id} className="flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => scrollToSection(id)}
                      aria-current={isActive ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors',
                        isActive
                          ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] ring-1 ring-[var(--border)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]/70 hover:text-[var(--text-primary)]'
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                      {label}
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>

          <main className="min-w-0 space-y-8">
            <ConfigHealthCard />

            <SectionChrome
              id="agents"
              title="Agent connections"
              description="Credentials and background waits for each CLI. Keys are encrypted per user; agent-level env vars win."
            >
              <div className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
                <div className="hidden border-b border-[var(--border)] bg-[var(--bg-primary)]/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] lg:grid lg:grid-cols-[11rem_minmax(0,1fr)_10.5rem] lg:gap-4">
                  <span>Runtime</span>
                  <span>Credential</span>
                  <span>Background wait</span>
                </div>
                {RUNNERS.map((meta) => (
                  <RunnerSettingsRow
                    key={meta.runner}
                    meta={meta}
                    configured={!!status?.[meta.runner]}
                    seconds={timeouts?.[meta.runner] ?? 0}
                  />
                ))}
              </div>
            </SectionChrome>

            <SectionChrome
              id="defaults"
              title="Run defaults"
              description="Conduit-wide prompt components applied to every run when enabled."
            >
              <PromptComponentManager />
            </SectionChrome>

            <SectionChrome
              id="storage"
              title="Storage"
              description="Disk usage under the Conduit data directory and safe cleanup."
            >
              <StorageMaintenancePanel />
            </SectionChrome>
          </main>
        </div>
      </div>
    </div>
  )
}
