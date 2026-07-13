import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Trash2, Save, CheckCircle2, Loader2, Copy, Share2 } from 'lucide-react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@renderer/components/ui/button'
import { AgentEditor, type AgentEditorHandle } from '@renderer/components/agents/AgentEditor'
import { ShareDialog } from '@renderer/components/ShareDialog'
import { RunControls } from '@renderer/components/runs/RunControls'
import { RunHistory } from '@renderer/components/runs/RunHistory'
import { RunDetail } from '@renderer/components/runs/RunDetail'
import { RunLogView } from '@renderer/components/runs/RunLogView'
import { useAgent, useDeleteAgent, useCloneAgent } from '@renderer/hooks/useAgents'
import { useRuns } from '@renderer/hooks/useRuns'
import { useAuth } from '@renderer/contexts/AuthContext'
import { useUIStore } from '@renderer/store/ui'
import { cn } from '@renderer/lib/utils'
import { api } from '@renderer/lib/ipc'

type Tab = 'configure' | 'runs'

interface MainPanelProps {
  agentId: string
}

export function MainPanel({ agentId }: MainPanelProps) {
  const { data: agent } = useAgent(agentId)
  const { data: runs } = useRuns(agentId)
  const deleteAgent = useDeleteAgent()
  const cloneAgent = useCloneAgent()
  const { user } = useAuth()
  const { activeRunId, selectAgent, viewedRunId, setViewedRun } = useUIStore()
  const isOwner = agent?.ownerId === user?.id
  const queryClient = useQueryClient()

  // Open on the runs tab when the URL deep-links a specific run.
  const [tab, setTab] = useState<Tab>(viewedRunId ? 'runs' : 'configure')

  const editorRef = useRef<AgentEditorHandle>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [showShareDialog, setShowShareDialog] = useState(false)

  // This agent's in-progress run, derived from its OWN runs list — so the Run
  // button + live view are per-agent, not keyed off a single global activeRunId
  // (which previously let a run be started per agent simultaneously). At most one
  // exists (the server rejects a second concurrent run per agent).
  const runningRun = useMemo(() => runs?.find((r) => r.status === 'running') ?? null, [runs])
  // runs are sorted newest-first, so [0] is the latest — used only for the
  // idle button label ("Run" vs "Run Again").
  const latestRun = runs && runs.length > 0 ? runs[0] : null

  // Any run status change for this agent refreshes its list (→ recomputes the
  // running run) and the affected run's log (so a finished run shows its full log).
  useEffect(() => {
    const unsub = api.onRunStatusChange((payload) => {
      queryClient.invalidateQueries({ queryKey: ['runs', agentId] })
      queryClient.invalidateQueries({ queryKey: ['run-log', payload.runId] })
    })
    return () => unsub()
  }, [agentId, queryClient])

  const handleDeleteAgent = async () => {
    if (!window.confirm(`Delete agent "${agent?.name}"? It will be removed from your list; its run history is preserved.`)) return
    await deleteAgent.mutateAsync(agentId)
    selectAgent(null)
  }

  const handleCloneAgent = async () => {
    if (!agent) return
    try {
      const clone = await cloneAgent.mutateAsync(agent)
      selectAgent(clone.id)
      setTab('configure')
    } catch (e) {
      console.error('Failed to clone agent:', e)
    }
  }

  // Which run the bottom pane shows: an explicit selection wins, else the
  // in-progress run. It's "live" only when that run is the one still running.
  const displayRunId = viewedRunId ?? activeRunId ?? runningRun?.id ?? null
  const showLiveTerminal = tab === 'runs' && displayRunId !== null && displayRunId === runningRun?.id
  const showReplayTerminal = tab === 'runs' && displayRunId !== null && !showLiveTerminal

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)] flex-shrink-0">
        <h1 className="text-sm font-semibold text-[var(--text-primary)] truncate">
          {agent ? (agent.name || '(Untitled agent)') : 'Agent'}
        </h1>
        <div className="flex items-center gap-2">
          {isOwner && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowShareDialog(true)}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-1.5"
              title="Share this agent"
            >
              <Share2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCloneAgent}
            disabled={!agent || cloneAgent.isPending}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-1.5"
            title="Clone this agent into a new agent"
          >
            {cloneAgent.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
          {saveState === 'saved' && (
            <span className="flex items-center gap-1 text-xs text-green-500">
              <CheckCircle2 className="h-3 w-3" />
              Saved
            </span>
          )}
          {saveState === 'error' && (
            <span className="text-xs text-red-400">Failed</span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => editorRef.current?.saveNow()}
            disabled={saveState === 'saving'}
            className="gap-1.5 text-xs"
            title="Save agent configuration"
          >
            {saveState === 'saving' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            Save
          </Button>
          <RunControls
            agentId={agentId}
            activeRunId={runningRun?.id ?? null}
            activeRunStatus={runningRun ? 'running' : latestRun?.status ?? null}
            activeRunStartedAt={runningRun?.startedAt ?? null}
            onRunStarted={() => {
              // setActiveRun (in RunControls) already points viewedRunId + URL at the
              // new run; the live terminal takes precedence while it's running.
              setTab('runs')
            }}
          />
          {isOwner && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDeleteAgent}
              className="text-[var(--text-secondary)] hover:text-red-400 px-1.5"
              title="Delete agent"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-[var(--border)] px-5 flex-shrink-0">
        {(['configure', 'runs'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-3 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize',
              tab === t
                ? 'border-[var(--accent)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {tab === 'configure' && (
          <div className="h-full overflow-y-auto">
            <AgentEditor ref={editorRef} agentId={agentId} onSaveStateChange={setSaveState} />
          </div>
        )}

        {tab === 'runs' && (
          <PanelGroup direction="vertical" className="h-full">
            {/* History list */}
            <Panel defaultSize={35} minSize={15}>
              <div className="h-full overflow-y-auto border-b border-[var(--border)]">
                <RunHistory
                  agentId={agentId}
                  selectedRunId={displayRunId}
                  onSelectRun={(runId) => {
                    // Sets viewedRunId + updates the URL for deep-linking. When it's
                    // the active run and still live, showLiveTerminal takes precedence.
                    setViewedRun(runId)
                  }}
                />
              </div>
            </Panel>

            <PanelResizeHandle className="h-1 bg-[var(--border)] hover:bg-[var(--accent)]/50 transition-colors cursor-row-resize" />

            {/* Terminal area */}
            <Panel defaultSize={65} minSize={20}>
              <div className="h-full">
                {showLiveTerminal && runningRun && (
                  <RunLogView runId={runningRun.id} live startedAt={runningRun.startedAt} />
                )}
                {showReplayTerminal && displayRunId && (
                  <RunDetail runId={displayRunId} />
                )}
                {!showLiveTerminal && !showReplayTerminal && (
                  <div className="flex items-center justify-center h-full text-sm text-[var(--text-secondary)]">
                    Select a run to view output
                  </div>
                )}
              </div>
            </Panel>
          </PanelGroup>
        )}
      </div>

      {showShareDialog && agent && (
        <ShareDialog
          entityType="agent"
          entityId={agent.id}
          isOpen={showShareDialog}
          onClose={() => setShowShareDialog(false)}
        />
      )}
    </div>
  )
}
