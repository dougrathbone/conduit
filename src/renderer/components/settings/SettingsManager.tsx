import React, { useState, useEffect } from 'react'
import { Check, Loader2, KeyRound, HardDrive, Trash2, Timer, ShieldCheck } from 'lucide-react'
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
  { runner: 'claude', label: 'Claude Code', envVar: 'ANTHROPIC_API_KEY', hint: 'Anthropic API key used to authenticate the Claude Code CLI.' },
  { runner: 'amp', label: 'Amp', envVar: 'AMP_API_KEY', hint: 'Sourcegraph Amp API key used to authenticate the Amp CLI.' },
  { runner: 'cursor', label: 'Cursor', envVar: 'CURSOR_API_KEY', hint: 'Cursor API key used to authenticate the cursor-agent CLI.' },
]

/**
 * One card per agent harness, holding both its credential (API key) and its
 * background-task timeout — the two per-harness settings live together instead of
 * in separate screen sections.
 */
function RunnerSettingsCard({
  meta,
  configured,
  seconds,
}: {
  meta: RunnerMeta
  configured: boolean
  seconds: number
}) {
  // Credential (API key) state.
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

  // Background-task timeout state.
  const [timeoutValue, setTimeoutValue] = useState(String(seconds))
  const saveTimeout = useSetRunnerTimeout()
  const timeoutBusy = saveTimeout.isPending
  const timeoutSupported = meta.runner === 'claude'

  // Keep the field in sync when the stored value changes (initial load / refetch).
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
    <div className="flex min-w-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
      <div className="flex min-h-[4.5rem] items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text-primary)]">{meta.label}</span>
            <code className="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
              {meta.envVar}
            </code>
          </div>
          <p className="mt-1 text-xs leading-4 text-[var(--text-secondary)]">{meta.hint}</p>
        </div>
        <span className={`flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${configured ? 'bg-emerald-500/10 text-emerald-500' : 'bg-[var(--bg-primary)] text-[var(--text-secondary)]'}`}>
          {configured && <Check className="h-3 w-3" />}
          {configured ? 'Connected' : 'Not set'}
        </span>
      </div>

      <label className="mt-4 text-[11px] font-medium text-[var(--text-secondary)]">API key</label>
      <div className="mt-1.5 flex items-center gap-2">
        <Input
          type="password"
          value={keyValue}
          onChange={(e) => setKeyValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSaveKey()
          }}
          placeholder={configured ? 'Replace existing key…' : 'Paste API key…'}
          autoComplete="off"
          className="flex-1"
        />
        <Button size="sm" onClick={handleSaveKey} disabled={!keyValue.trim() || credBusy} className="gap-1.5">
          {credBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save
        </Button>
      </div>
      {configured && (
        <button
          type="button"
          onClick={handleClearKey}
          disabled={credBusy}
          className="mt-1.5 w-fit text-[11px] text-[var(--text-secondary)] hover:text-red-400 disabled:opacity-50"
        >
          Remove saved key
        </button>
      )}

      <div className="mt-auto border-t border-[var(--border)] pt-4">
        <div className="flex items-center gap-2">
          <Timer className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
          <span className="text-xs font-medium text-[var(--text-primary)]">Background wait</span>
          {!timeoutSupported && (
            <span className="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--text-secondary)]">
              Not applied
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] leading-4 text-[var(--text-secondary)]">
          {timeoutSupported ? 'How long to wait for background work. Use 0 for no limit.' : 'Saved for future CLI support.'}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Input
            type="number"
            min={0}
            value={timeoutValue}
            onChange={(e) => setTimeoutValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveTimeout()
            }}
            className="w-20"
          />
          <span className="text-xs text-[var(--text-secondary)]">sec</span>
          <Button size="sm" variant="outline" onClick={handleSaveTimeout} disabled={timeoutBusy || !timeoutDirty} className="ml-auto gap-1.5">
            {timeoutBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
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
      <div className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)] mt-1">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Calculating storage usage…
      </div>
    )
  }

  if (usage.isError || !usage.data) {
    return (
      <div className="text-xs text-[var(--text-secondary)] mt-1">
        Couldn't measure storage usage.
      </div>
    )
  }

  const { totalBytes, reclaimableBytes } = usage.data
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-semibold text-[var(--text-primary)]">
          {formatBytes(totalBytes)}
        </span>
        <span className="text-sm text-[var(--text-secondary)]">in use</span>
        {usage.isFetching && <Loader2 className="h-3 w-3 animate-spin text-[var(--text-secondary)]" />}
      </div>
      {reclaimableBytes > 0 && (
        <div className="text-xs text-[var(--text-secondary)] mt-0.5">
          {formatBytes(reclaimableBytes)} reclaimable from finished runs
        </div>
      )}
    </div>
  )
}

function StorageMaintenanceCard() {
  const sweep = useDataDirSweep()

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--bg-primary)] text-[var(--text-secondary)]">
            <HardDrive className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Conduit data</div>
            <StorageUsageSummary />
            <p className="mt-2 max-w-2xl text-xs leading-4 text-[var(--text-secondary)]">
              Clean up worktrees, temporary workspaces, and MCP files left by finished runs.
              Active runs are never touched.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending}
          className="gap-1.5 flex-shrink-0"
        >
          {sweep.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          Clean up now
        </Button>
      </div>
      {sweep.data && !sweep.isPending && (
        <p className="text-xs text-green-500 mt-3">{sweepSummary(sweep.data)}</p>
      )}
      {sweep.isError && (
        <p className="text-xs text-red-400 mt-3">
          Cleanup failed: {sweep.error instanceof Error ? sweep.error.message : String(sweep.error)}
        </p>
      )}
    </div>
  )
}

export function SettingsManager() {
  const { data: status } = useAgentCredentialStatus()
  const { data: timeouts } = useRunnerTimeouts()

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      <div className="flex-shrink-0 border-b border-[var(--border)]">
        <div className="mx-auto w-full max-w-6xl px-5 py-5 sm:px-8">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
            <ShieldCheck className="h-3.5 w-3.5" />
            Workspace administration
          </div>
          <h1 className="mt-2 text-xl font-semibold tracking-tight text-[var(--text-primary)]">Conduit settings</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Check readiness, connect agent runtimes, and manage defaults for every run.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-6xl space-y-10 px-5 py-6 pb-16 sm:px-8 sm:py-8">
          <ConfigHealthCard />

          <section>
            <div className="mb-4">
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Agent connections</h2>
              <p className="mt-1 max-w-3xl text-sm text-[var(--text-secondary)]">
                Add credentials for the CLIs your agents use. Keys are encrypted and scoped to your account;
                settings on an individual agent take precedence.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {RUNNERS.map((meta) => (
                <RunnerSettingsCard
                  key={meta.runner}
                  meta={meta}
                  configured={!!status?.[meta.runner]}
                  seconds={timeouts?.[meta.runner] ?? 0}
                />
              ))}
            </div>
          </section>

          <section className="border-t border-[var(--border)] pt-8">
            <PromptComponentManager />
          </section>

          <section className="border-t border-[var(--border)] pt-8">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Storage</h2>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                See how much space Conduit uses and safely reclaim files from completed runs.
              </p>
            </div>
            <StorageMaintenanceCard />
          </section>
        </main>
      </div>
    </div>
  )
}
