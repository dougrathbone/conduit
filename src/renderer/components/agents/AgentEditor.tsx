import React, { useEffect, useState, useCallback, useRef } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { PromptEditor } from './PromptEditor'
import { EnvVarEditor } from './EnvVarEditor'
import { McpEditor } from './McpEditor'
import { useAgent, useUpdateAgent } from '@renderer/hooks/useAgents'
import type { AgentConfig, RunnerType } from '@shared/types'

// Inline SVG logos for each runner
const RunnerLogos: Record<RunnerType, React.FC<{ size?: number; active?: boolean }>> = {
  claude: ({ size = 22 }) => (
    // Anthropic Claude mark — simplified stylised "A" shape
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M13.827 3.54L19.66 18h-3.133l-1.224-3.24H8.697L7.473 18H4.34L10.173 3.54h3.654zm-1.827 4.09L9.73 12.48h4.54L12 7.63z" fill="currentColor"/>
    </svg>
  ),
  amp: ({ size = 22 }) => (
    // Amp "lightning bolt" style mark
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M13 2L4.5 13.5H11L10 22L19.5 10.5H13L13 2Z" fill="currentColor" strokeLinejoin="round"/>
    </svg>
  ),
  cursor: ({ size = 22 }) => (
    // Cursor — stylised cursor/arrow shape
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 3l16 9-7.5 1.5L9 21z" fill="currentColor"/>
    </svg>
  ),
}

const RUNNER_OPTIONS: { value: RunnerType; label: string; description: string }[] = [
  { value: 'claude', label: 'Claude Code', description: 'Anthropic' },
  { value: 'amp',    label: 'Amp',         description: 'Sourcegraph' },
  { value: 'cursor', label: 'Cursor',      description: 'Anysphere' },
]

function RunnerPicker({
  value,
  onChange,
}: {
  value: RunnerType
  onChange: (r: RunnerType) => void
}) {
  return (
    <div className="flex gap-2">
      {RUNNER_OPTIONS.map((opt) => {
        const Logo = RunnerLogos[opt.value]
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="flex flex-col items-center gap-1.5 rounded-xl px-4 py-3 transition-all duration-150 flex-1 group"
            style={{
              background: active ? 'var(--accent)' : 'var(--bg-secondary)',
              border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              color: active ? '#fff' : 'var(--text-secondary)',
              boxShadow: active ? '0 2px 12px rgba(129,140,248,0.35)' : 'none',
            }}
          >
            <span style={{ opacity: active ? 1 : 0.6 }} className="transition-opacity group-hover:opacity-100">
              <Logo size={20} active={active} />
            </span>
            <span className="text-[10px] font-semibold tracking-wide leading-tight" style={{ fontFamily: 'monospace' }}>
              {opt.label}
            </span>
            <span className="text-[9px] opacity-60 leading-none">{opt.description}</span>
          </button>
        )
      })}
    </div>
  )
}

interface AgentEditorProps {
  agentId: string
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function AgentEditor({ agentId }: AgentEditorProps) {
  const { data: agent, isLoading } = useAgent(agentId)
  const updateAgent = useUpdateAgent()

  const [draft, setDraft] = useState<Partial<AgentConfig>>({})
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initializedRef = useRef<string | null>(null)

  // Initialize draft from agent data
  useEffect(() => {
    if (agent && initializedRef.current !== agent.id) {
      initializedRef.current = agent.id
      setDraft({
        name: agent.name,
        runner: agent.runner,
        prompt: agent.prompt,
        envVars: agent.envVars,
        mcpConfig: agent.mcpConfig,
        gistId: agent.gistId,
      })
    }
  }, [agent])

  const save = useCallback(
    async (updates: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>) => {
      setSaveState('saving')
      try {
        await updateAgent.mutateAsync({ id: agentId, data: updates })
        setSaveState('saved')
        setTimeout(() => setSaveState('idle'), 2000)
      } catch {
        setSaveState('error')
        setTimeout(() => setSaveState('idle'), 3000)
      }
    },
    [agentId, updateAgent]
  )

  const scheduleSave = useCallback(
    (updates: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        save(updates)
      }, 500)
    },
    [save]
  )

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const handleChange = useCallback(
    (field: keyof typeof draft, value: unknown) => {
      const updated = { ...draft, [field]: value }
      setDraft(updated)
      const { name, runner, prompt, envVars, mcpConfig, gistId } = updated
      scheduleSave({ name, runner, prompt, envVars, mcpConfig, gistId })
    },
    [draft, scheduleSave]
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-[var(--text-secondary)]">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="px-6 py-8 text-sm text-[var(--text-secondary)]">
        Agent not found.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex-1 px-6 py-5 space-y-6 max-w-2xl">
        {/* Save indicator */}
        <div className="flex items-center justify-end h-5">
          {saveState === 'saving' && (
            <span className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              Saving...
            </span>
          )}
          {saveState === 'saved' && (
            <span className="flex items-center gap-1.5 text-xs text-green-500">
              <CheckCircle2 className="h-3 w-3" />
              Saved
            </span>
          )}
          {saveState === 'error' && (
            <span className="text-xs text-red-400">Failed to save</span>
          )}
        </div>

        {/* Name */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Name
          </label>
          <Input
            value={draft.name ?? ''}
            onChange={(e) => handleChange('name', e.target.value)}
            placeholder="My Agent"
          />
        </div>

        {/* Runner */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Runner
          </label>
          <RunnerPicker
            value={draft.runner ?? 'claude'}
            onChange={(r) => handleChange('runner', r)}
          />
        </div>

        {/* Prompt */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Prompt
          </label>
          <PromptEditor
            value={draft.prompt ?? ''}
            onChange={(v) => handleChange('prompt', v)}
            gistId={draft.gistId}
            onGistIdChange={(gistId) => handleChange('gistId', gistId)}
            agentId={agentId}
            runner={draft.runner ?? agent.runner}
          />
        </div>

        {/* Environment Variables */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Environment Variables
          </label>
          <EnvVarEditor
            value={draft.envVars ?? {}}
            onChange={(v) => handleChange('envVars', v)}
          />
        </div>

        {/* MCP Config */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            MCP Configuration
          </label>
          <McpEditor
            value={draft.mcpConfig ?? { mcpServers: {} }}
            onChange={(v) => handleChange('mcpConfig', v)}
          />
        </div>
      </div>
    </div>
  )
}
