import React, { useState, useEffect } from 'react'
import { Info, Check, Loader2, KeyRound, HardDrive, Trash2, Timer } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useAgentCredentialStatus, useSetAgentCredential } from '@renderer/hooks/useAgentCredentials'
import { useRunnerTimeouts, useSetRunnerTimeout } from '@renderer/hooks/useRunnerTimeouts'
import { useDataDirSweep } from '@renderer/hooks/useDataDirSweep'
import { useStorageUsage } from '@renderer/hooks/useStorageUsage'
import { formatBytes } from '@renderer/lib/utils'
import type { RunnerType, SweepResult } from '@shared/types'

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

function CredentialRow({ meta, configured }: { meta: RunnerMeta; configured: boolean }) {
  const [value, setValue] = useState('')
  const setCredential = useSetAgentCredential()
  const busy = setCredential.isPending

  const handleSave = async () => {
    if (!value.trim()) return
    try {
      await setCredential.mutateAsync({ runner: meta.runner, value })
      setValue('')
    } catch (err) {
      console.error('Failed to save credential:', err)
    }
  }

  const handleClear = async () => {
    try {
      await setCredential.mutateAsync({ runner: meta.runner, value: '' })
      setValue('')
    } catch (err) {
      console.error('Failed to clear credential:', err)
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] px-4 py-3.5" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <KeyRound className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">{meta.label}</span>
              <code className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)]">
                {meta.envVar}
              </code>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">{meta.hint}</p>
          </div>
        </div>
        {configured ? (
          <span className="flex items-center gap-1 text-xs font-medium text-green-500 flex-shrink-0">
            <Check className="h-3.5 w-3.5" />
            Configured
          </span>
        ) : (
          <span className="text-xs text-[var(--text-secondary)] flex-shrink-0">Not set</span>
        )}
      </div>

      <div className="flex items-center gap-2 mt-3">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave()
          }}
          placeholder={configured ? 'Enter a new key to replace the stored one…' : 'Paste API key…'}
          autoComplete="off"
          className="flex-1"
        />
        <Button size="sm" onClick={handleSave} disabled={!value.trim() || busy} className="gap-1.5">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save
        </Button>
        {configured && (
          <Button size="sm" variant="ghost" onClick={handleClear} disabled={busy}>
            Clear
          </Button>
        )}
      </div>
    </div>
  )
}

function RunnerTimeoutRow({ meta, seconds }: { meta: RunnerMeta; seconds: number }) {
  const [value, setValue] = useState(String(seconds))
  const saveTimeout = useSetRunnerTimeout()
  const busy = saveTimeout.isPending
  const supported = meta.runner === 'claude'

  // Keep the field in sync when the stored value changes (initial load / refetch).
  useEffect(() => {
    setValue(String(seconds))
  }, [seconds])

  const dirty = String(seconds) !== value.trim()

  const handleSave = async () => {
    const n = Math.max(0, Math.floor(Number(value) || 0))
    try {
      await saveTimeout.mutateAsync({ runner: meta.runner, seconds: n })
      setValue(String(n))
    } catch (err) {
      console.error('Failed to save timeout:', err)
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] px-4 py-3.5" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Timer className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">{meta.label}</span>
              {!supported && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)]">
                  no effect yet
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {supported
                ? 'Injected as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS. 0 = wait indefinitely.'
                : 'No known wait-ceiling env var for this CLI yet — stored, but not applied.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Input
            type="number"
            min={0}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
            }}
            className="w-24"
          />
          <span className="text-xs text-[var(--text-secondary)]">sec</span>
          <Button size="sm" onClick={handleSave} disabled={busy || !dirty} className="gap-1.5">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

function BackgroundTimeoutSection() {
  const { data } = useRunnerTimeouts()
  return (
    <>
      {RUNNERS.map((meta) => (
        <RunnerTimeoutRow key={meta.runner} meta={meta} seconds={data?.[meta.runner] ?? 0} />
      ))}
    </>
  )
}

function sweepSummary(r: SweepResult): string {
  const parts: string[] = []
  if (r.worktreesRemoved) parts.push(`${r.worktreesRemoved} worktree${r.worktreesRemoved === 1 ? '' : 's'}`)
  if (r.workspacesRemoved) parts.push(`${r.workspacesRemoved} workspace${r.workspacesRemoved === 1 ? '' : 's'}`)
  if (r.mcpConfigsRemoved) parts.push(`${r.mcpConfigsRemoved} MCP config${r.mcpConfigsRemoved === 1 ? '' : 's'}`)
  if (r.logsRemoved) parts.push(`${r.logsRemoved} old log${r.logsRemoved === 1 ? '' : 's'}`)
  if (r.bareClonesRemoved) parts.push(`${r.bareClonesRemoved} orphaned clone${r.bareClonesRemoved === 1 ? '' : 's'}`)
  return parts.length ? `Removed ${parts.join(', ')}.` : 'Nothing to clean up — already tidy.'
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
    <div className="mt-1">
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
    <div className="rounded-lg border border-[var(--border)] px-4 py-3.5" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <HardDrive className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)] mt-0.5" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--text-primary)]">Data directory</div>
            <StorageUsageSummary />
            <p className="text-xs text-[var(--text-secondary)] mt-2">
              Reclaim disk from finished runs — orphaned git worktrees, temp workspaces, and per-run
              MCP configs. This happens automatically after each run and on a timer; run it now to
              clean up immediately. Runs currently executing are never touched.
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

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">Settings</h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            Agent authentication and storage maintenance
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 max-w-2xl">
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-xs text-[var(--text-secondary)]">
          <Info className="h-3.5 w-3.5 text-[var(--accent)] flex-shrink-0 mt-0.5" />
          <span>
            API keys are encrypted at rest and injected into each run as the runner's environment
            variable. They're scoped to your account — every agent you own uses your keys. An
            explicit env var set on an agent overrides the key you store here.
          </span>
        </div>

        <h2 className="text-xs font-medium text-[var(--text-secondary)] pt-1">Agent credentials</h2>
        {RUNNERS.map((meta) => (
          <CredentialRow key={meta.runner} meta={meta} configured={!!status?.[meta.runner]} />
        ))}

        <h2 className="text-xs font-medium text-[var(--text-secondary)] pt-3">Background task timeout</h2>
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-xs text-[var(--text-secondary)]">
          <Info className="h-3.5 w-3.5 text-[var(--accent)] flex-shrink-0 mt-0.5" />
          <span>
            How long a runner waits for background tasks before terminating them, in seconds.
            <strong className="text-[var(--text-primary)]"> 0 means wait indefinitely</strong> (the
            default). An individual agent can override this in its settings.
          </span>
        </div>
        <BackgroundTimeoutSection />

        <h2 className="text-xs font-medium text-[var(--text-secondary)] pt-3">Storage maintenance</h2>
        <StorageMaintenanceCard />
      </div>
    </div>
  )
}
