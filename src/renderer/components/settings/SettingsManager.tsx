import React, { useState, useEffect, useId } from 'react'
import {
  Check,
  ChevronDown,
  HardDrive,
  KeyRound,
  ListChecks,
  Loader2,
  Timer,
  Trash2,
} from 'lucide-react'
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
  shortHint: string
}

const RUNNERS: RunnerMeta[] = [
  {
    runner: 'claude',
    label: 'Claude Code',
    envVar: 'ANTHROPIC_API_KEY',
    hint: 'Anthropic API key used to authenticate the Claude Code CLI.',
    shortHint: 'Lets agents run with Claude Code.',
  },
  {
    runner: 'amp',
    label: 'Amp',
    envVar: 'AMP_API_KEY',
    hint: 'Sourcegraph Amp API key used to authenticate the Amp CLI.',
    shortHint: 'Lets agents run with Amp.',
  },
  {
    runner: 'cursor',
    label: 'Cursor',
    envVar: 'CURSOR_API_KEY',
    hint: 'Cursor API key used to authenticate the cursor-agent CLI.',
    shortHint: 'Lets agents run with Cursor.',
  },
]

/**
 * Compact, expand-to-edit card for one agent harness: credential + timeout.
 * Collapsed by default so the setup journey stays scannable.
 */
function RunnerSetupCard({
  meta,
  configured,
  seconds,
  stepIndex,
}: {
  meta: RunnerMeta
  configured: boolean
  seconds: number
  stepIndex: number
}) {
  const panelId = useId()
  const [open, setOpen] = useState(!configured)
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
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-primary)]/40"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ${
            configured
              ? 'bg-emerald-500 text-white'
              : 'border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)]'
          }`}
          aria-hidden
        >
          {configured ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : stepIndex}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text-primary)]">{meta.label}</span>
            <span
              className={`text-[11px] font-medium ${
                configured ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--text-secondary)]'
              }`}
            >
              {configured ? 'Key saved' : 'Add your API key'}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{meta.shortHint}</p>
        </div>
        <ChevronDown
          className={`h-4 w-4 flex-shrink-0 text-[var(--text-secondary)] transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open && (
        <div
          id={panelId}
          className="border-t border-[var(--border)] bg-[var(--bg-primary)]/25 px-4 py-4"
        >
          <p className="text-xs leading-4 text-[var(--text-secondary)]">{meta.hint}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="rounded bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
              {meta.envVar}
            </code>
            {configured && (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                <KeyRound className="h-3 w-3" />
                Encrypted for your account
              </span>
            )}
          </div>

          <label className="mt-4 block text-[11px] font-medium text-[var(--text-secondary)]">
            API key
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-center">
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
              Save key
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

          <details className="mt-4 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/80 px-3 py-2">
            <summary className="cursor-pointer list-none text-xs font-medium text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
              <span className="inline-flex items-center gap-1.5">
                <Timer className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                Advanced: background wait
                {!timeoutSupported && (
                  <span className="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--text-secondary)]">
                    Not applied yet
                  </span>
                )}
              </span>
            </summary>
            <p className="mt-2 text-[11px] leading-4 text-[var(--text-secondary)]">
              {timeoutSupported
                ? 'How long to wait for background work. Use 0 for no limit.'
                : 'Saved for future CLI support — changing it has no effect today.'}
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
              <Button
                size="sm"
                variant="outline"
                onClick={handleSaveTimeout}
                disabled={timeoutBusy || !timeoutDirty}
                className="ml-auto gap-1.5"
              >
                {timeoutBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </Button>
            </div>
          </details>
        </div>
      )}
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
      <div className="mt-1 flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Calculating storage usage…
      </div>
    )
  }

  if (usage.isError || !usage.data) {
    return <div className="mt-1 text-xs text-[var(--text-secondary)]">Couldn't measure storage usage.</div>
  }

  const { totalBytes, reclaimableBytes } = usage.data
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-semibold text-[var(--text-primary)]">{formatBytes(totalBytes)}</span>
        <span className="text-sm text-[var(--text-secondary)]">in use</span>
        {usage.isFetching && <Loader2 className="h-3 w-3 animate-spin text-[var(--text-secondary)]" />}
      </div>
      {reclaimableBytes > 0 && (
        <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
          {formatBytes(reclaimableBytes)} reclaimable from finished runs
        </div>
      )}
    </div>
  )
}

function StorageMaintenanceCard() {
  const sweep = useDataDirSweep()

  return (
    <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-primary)]/40 px-4 py-4">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
            <HardDrive className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--text-primary)]">Disk cleanup</div>
            <StorageUsageSummary />
            <p className="mt-2 max-w-2xl text-xs leading-4 text-[var(--text-secondary)]">
              Free space from finished runs. Active work is never touched.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending}
          className="flex-shrink-0 gap-1.5"
        >
          {sweep.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          Clean up now
        </Button>
      </div>
      {sweep.data && !sweep.isPending && (
        <p className="mt-3 text-xs text-green-500">{sweepSummary(sweep.data)}</p>
      )}
      {sweep.isError && (
        <p className="mt-3 text-xs text-red-400">
          Cleanup failed: {sweep.error instanceof Error ? sweep.error.message : String(sweep.error)}
        </p>
      )}
    </div>
  )
}

export function SettingsManager() {
  const { data: status } = useAgentCredentialStatus()
  const { data: timeouts } = useRunnerTimeouts()
  const connectedCount = RUNNERS.filter((m) => status?.[m.runner]).length

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      <div className="flex-shrink-0 border-b border-[var(--border)]">
        <div className="mx-auto w-full max-w-3xl px-5 py-6 sm:px-8">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
            <ListChecks className="h-3.5 w-3.5" />
            Guided setup
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
            Get Conduit ready
          </h1>
          <p className="mt-1.5 max-w-xl text-sm leading-5 text-[var(--text-secondary)]">
            Follow the checklist to confirm the server basics, then add the agent keys you need.
            Everything else stays optional until you want it.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-3xl space-y-10 px-5 py-6 pb-16 sm:px-8 sm:py-8">
          <ConfigHealthCard />

          <section aria-labelledby="agent-keys-heading">
            <div className="mb-1 flex items-start gap-3">
              <span
                className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${
                  connectedCount === RUNNERS.length
                    ? 'bg-emerald-500 text-white'
                    : 'border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
                }`}
                aria-hidden
              >
                {connectedCount === RUNNERS.length ? (
                  <Check className="h-4 w-4" strokeWidth={2.5} />
                ) : (
                  4
                )}
              </span>
              <div className="min-w-0">
                <h2 id="agent-keys-heading" className="text-base font-semibold text-[var(--text-primary)]">
                  Connect the agents you’ll use
                </h2>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                  Paste an API key for each CLI you care about. Keys stay encrypted to your account;
                  you only need the ones you’ll actually run. Open a row to add or replace a key.
                </p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {connectedCount} of {RUNNERS.length} connected
                  {connectedCount === 0 ? ' — start with the CLI you use most.' : '.'}
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-2 sm:ml-11">
              {RUNNERS.map((meta, i) => (
                <RunnerSetupCard
                  key={meta.runner}
                  meta={meta}
                  configured={!!status?.[meta.runner]}
                  seconds={timeouts?.[meta.runner] ?? 0}
                  stepIndex={4 + i}
                />
              ))}
            </div>
          </section>

          <section
            className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-secondary)]/50 px-5 py-6 sm:px-6"
            aria-labelledby="optional-tuning-heading"
          >
            <div className="mb-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
                Optional · later
              </p>
              <h2
                id="optional-tuning-heading"
                className="mt-1.5 text-base font-semibold text-[var(--text-primary)]"
              >
                Run defaults & storage
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
                These don’t block getting started. Adjust shared prompt defaults or reclaim disk when
                you need them.
              </p>
            </div>

            <div className="space-y-8">
              <PromptComponentManager />
              <div className="border-t border-[var(--border)] pt-6">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">Storage</h3>
                <p className="mt-1 mb-3 text-xs text-[var(--text-secondary)]">
                  See how much space Conduit uses and safely reclaim files from completed runs.
                </p>
                <StorageMaintenanceCard />
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}
