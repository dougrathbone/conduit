import React, { useEffect, useState, useCallback, useRef } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Select } from '@renderer/components/ui/select'
import { PromptEditor } from './PromptEditor'
import { EnvVarEditor } from './EnvVarEditor'
import { McpEditor } from './McpEditor'
import { useAgent, useUpdateAgent } from '@renderer/hooks/useAgents'
import type { AgentConfig, RunnerType } from '@shared/types'

const RUNNER_OPTIONS: { value: RunnerType; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'amp', label: 'Amp' },
  { value: 'cursor', label: 'Cursor' },
]

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
          <Select
            value={draft.runner ?? 'claude'}
            onChange={(e) => handleChange('runner', e.target.value as RunnerType)}
          >
            {RUNNER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
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
