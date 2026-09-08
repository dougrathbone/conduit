import React, { useState, useEffect } from 'react'
import { Check, Loader2, HardDrive, Trash2, Timer, Gauge, Cable } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useAgentCredentialStatus, useSetAgentCredential } from '@renderer/hooks/useAgentCredentials'
import { useRunnerTimeouts, useSetRunnerTimeout } from '@renderer/hooks/useRunnerTimeouts'
import { useDataDirSweep } from '@renderer/hooks/useDataDirSweep'
import { useStorageUsage } from '@renderer/hooks/useStorageUsage'
import { formatBytes } from '@renderer/lib/utils'
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
  { runner: 'claude', label: 'Claude Code', envVar: 'ANTHROPIC_API_KEY', hint: 'Anthropic API key for the Claude Code CLI.' },
  { runner: 'amp', label: 'Amp', envVar: 'AMP_API_KEY', hint: 'Sourcegraph Amp API key for the Amp CLI.' },
  { runner: 'cursor', label: 'Cursor', envVar: 'CURSOR_API_KEY', hint: 'Cursor API key for the cursor-agent CLI.' },
]

/**
 * Compact connection-matrix row: credential + background wait in one dense line
 * instead of a large per-runner card.
 */
function RunnerMatrixRow({
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

  const [timeoutValue, setTimeoutValue] = useState(String(seconds))
  const saveTimeout = useSetRunnerTimeout()
  const timeoutBusy = saveTimeout.isPending
  const timeoutSupported = meta.runner === 'claude'

  useEffect(() => {
    setTimeoutValue(String(seconds))
  }, [seconds])

  const timeoutDirty = String(seconds) !== timeoutValue.trim()

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
    <div className="grid gap-3 border-b border-[var(--border)] px-4 py-3 last:border-b-0 sm:px-5 lg:grid-cols-[minmax(10rem,0.85fr)_minmax(0,1.6fr)_minmax(11rem,0.9fr)] lg:items-start lg:gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">{meta.label}</span>
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              configured
                ? 'bg-emerald-500/10 text-emerald-500'
                : 'bg-[var(--bg-primary)] text-[var(--text-secondary)]'
            }`}
          >
            {configured && <Check className="h-3 w-3" />}
            {configured ? 'Linked' : 'Unset'}
          </span>
        </div>
        <code className="mt-1 block truncate font-mono text-[10px] text-[var(--text-secondary)]">
          {meta.envVar}
        </code>
        <p className="mt-1 text-[11px] leading-4 text-[var(--text-secondary)] lg:hidden">{meta.hint}</p>
      </div>

      <div className="min-w-0">
        <label className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
          Credential
        </label>
        <div className="mt-1 flex items-center gap-2">
          <Input
            type="password"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveKey()
            }}
            placeholder={configured ? 'Replace key…' : 'Paste API key…'}
            autoComplete="off"
            className="h-8 flex-1 text-xs"
          />
          <Button size="sm" onClick={handleSaveKey} disabled={!keyValue.trim() || credBusy} className="h-8 gap-1 px-2.5 text-xs">
            {credBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Save
          </Button>
        </div>
        {configured && (
          <button
            type="button"
            onClick={handleClearKey}
            disabled={credBusy}
            className="mt-1 text-[10px] text-[var(--text-secondary)] hover:text-red-400 disabled:opacity-50"
          >
            Clear key
          </button>
        )}
      </div>

      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Timer className="h-3 w-3 text-[var(--text-secondary)]" />
          <label className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
            Background wait
          </label>
          {!timeoutSupported && (
            <span className="rounded bg-[var(--bg-primary)] px-1 py-0.5 text-[9px] uppercase tracking-wide text-[var(--text-secondary)]">
              N/A
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <Input
            type="number"
            min={0}
            value={timeoutValue}
            onChange={(e) => setTimeoutValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveTimeout()
            }}
            className="h-8 w-[4.5rem] text-xs"
            disabled={!timeoutSupported}
          />
          <span className="text-[11px] text-[var(--text-secondary)]">sec</span>
          <Button
            size="sm"
            variant="outline"
            onClick={handleSaveTimeout}
            disabled={!timeoutSupported || timeoutBusy || !timeoutDirty}
            className="ml-auto h-8 gap-1 px-2.5 text-xs"
          >
            {timeoutBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Set
          </Button>
        </div>
        <p className="mt-1 text-[10px] leading-3.5 text-[var(--text-secondary)]">
          {timeoutSupported ? '0 = no limit' : 'Stored for future CLI support'}
        </p>
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

function StorageOpsPanel() {
  const usage = useStorageUsage()
  const sweep = useDataDirSweep()

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-primary)]/40 px-4 py-2 sm:px-5">
        <div className="flex items-center gap-2">
          <HardDrive className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Storage · Data plane
          </span>
        </div>
        <Button
          size="sm"
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending}
          className="h-7 gap-1.5 px-2.5 text-xs"
        >
          {sweep.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          Clean up now
        </Button>
      </div>

      <div className="grid gap-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="border-b border-[var(--border)] p-4 sm:border-b-0 sm:border-r sm:p-5">
          <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
            Footprint
          </div>
          {usage.isLoading ? (
            <div className="mt-3 flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Measuring…
            </div>
          ) : usage.isError || !usage.data ? (
            <p className="mt-3 text-xs text-[var(--text-secondary)]">Couldn't measure storage usage.</p>
          ) : (
            <>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--text-primary)]">
                  {formatBytes(usage.data.totalBytes)}
                </span>
                <span className="text-xs text-[var(--text-secondary)]">in use</span>
                {usage.isFetching && <Loader2 className="h-3 w-3 animate-spin text-[var(--text-secondary)]" />}
              </div>
              <div className="mt-3 rounded border border-[var(--border)] bg-[var(--bg-primary)]/50 px-3 py-2">
                <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">
                  Reclaimable
                </div>
                <div className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                  {formatBytes(usage.data.reclaimableBytes)}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="p-4 sm:p-5">
          <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
            Maintenance
          </div>
          <p className="mt-2 text-xs leading-4 text-[var(--text-secondary)]">
            Reclaim worktrees, temporary workspaces, and MCP files left by finished runs. Active runs are never touched.
          </p>
          {sweep.data && !sweep.isPending && (
            <p className="mt-3 text-xs text-green-500">{sweepSummary(sweep.data)}</p>
          )}
          {sweep.isError && (
            <p className="mt-3 text-xs text-red-400">
              Cleanup failed: {sweep.error instanceof Error ? sweep.error.message : String(sweep.error)}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function SectionChrome({
  icon,
  code,
  title,
  blurb,
}: {
  icon: React.ReactNode
  code: string
  title: string
  blurb: string
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {icon}
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-secondary)]">
            {code}
          </span>
        </div>
        <h2 className="mt-1 text-base font-semibold text-[var(--text-primary)]">{title}</h2>
        <p className="mt-0.5 max-w-2xl text-xs text-[var(--text-secondary)]">{blurb}</p>
      </div>
    </div>
  )
}

export function SettingsManager() {
  const { data: status } = useAgentCredentialStatus()
  const { data: timeouts } = useRunnerTimeouts()
  const linkedCount = RUNNERS.filter((m) => !!status?.[m.runner]).length

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      <div className="flex-shrink-0 border-b border-[var(--border)] bg-[var(--bg-secondary)]/40">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-5 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-8 sm:py-5">
          <div>
            <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              <Gauge className="h-3.5 w-3.5" />
              Operations dashboard
            </div>
            <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-[var(--text-primary)]">
              Instance settings
            </h1>
            <p className="mt-1 max-w-xl text-sm text-[var(--text-secondary)]">
              Readiness probes, agent links, run defaults, and storage — scanned like an ops console.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5">
              <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">Agents linked</div>
              <div className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                {linkedCount}/{RUNNERS.length}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-6xl space-y-8 px-5 py-5 pb-16 sm:px-8 sm:py-6">
          <ConfigHealthCard />

          <section>
            <SectionChrome
              icon={<Cable className="h-3.5 w-3.5 text-[var(--text-secondary)]" />}
              code="CONN · Agent matrix"
              title="Agent connections"
              blurb="Credentials and background waits in one dense matrix. Per-agent env still wins at run time."
            />
            <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
              <div className="hidden border-b border-[var(--border)] bg-[var(--bg-primary)]/35 px-5 py-2 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)] lg:grid lg:grid-cols-[minmax(10rem,0.85fr)_minmax(0,1.6fr)_minmax(11rem,0.9fr)] lg:gap-4">
                <span>Runtime</span>
                <span>API key</span>
                <span>Run default</span>
              </div>
              {RUNNERS.map((meta) => (
                <RunnerMatrixRow
                  key={meta.runner}
                  meta={meta}
                  configured={!!status?.[meta.runner]}
                  seconds={timeouts?.[meta.runner] ?? 0}
                />
              ))}
            </div>
          </section>

          <section className="border-t border-[var(--border)] pt-7">
            <PromptComponentManager />
          </section>

          <section className="border-t border-[var(--border)] pt-7">
            <SectionChrome
              icon={<HardDrive className="h-3.5 w-3.5 text-[var(--text-secondary)]" />}
              code="DISK · Retention"
              title="Storage"
              blurb="Footprint and reclaimable capacity at a glance."
            />
            <StorageOpsPanel />
          </section>
        </main>
      </div>
    </div>
  )
}
