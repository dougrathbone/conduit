import React, { useState } from 'react'
import { Info, Plus } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useUIStore } from '@renderer/store/ui'
import { useGlobalMcps } from '@renderer/hooks/useGlobalMcps'
import { McpServerForm, type McpServerFormValues } from '@renderer/components/mcp/McpServerForm'
import { McpServerRow } from '@renderer/components/mcp/McpServerRow'
import type { McpServersConfig } from '@shared/types'

interface McpEditorProps {
  value: McpServersConfig
  onChange: (value: McpServersConfig) => void
  /** Agent ID — enables health/tools/OAuth for this agent's servers ("{agentId}:{serverKey}"). */
  agentId?: string
  /**
   * Flush any pending debounced save of `mcpConfig` before an OAuth flow starts,
   * so the server resolves the up-to-date config for "{agentId}:{serverKey}".
   */
  flushSave?: () => Promise<void> | void
}

export function McpEditor({ value, onChange, agentId, flushSave }: McpEditorProps) {
  const { theme, setShowGlobalMcpManager } = useUIStore()
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const { data: globalMcps = [] } = useGlobalMcps()
  const enabledGlobalCount = globalMcps.filter((m) => m.enabled).length

  const [showAddForm, setShowAddForm] = useState(false)

  const servers = value?.mcpServers ?? {}
  const serverKeys = Object.keys(servers)

  const serverIdFor = (key: string) => (agentId ? `${agentId}:${key}` : key)

  const handleAdd = async (values: McpServerFormValues): Promise<{ ok: boolean; error?: string }> => {
    if (servers[values.serverKey]) {
      return { ok: false, error: `A server with the key "${values.serverKey}" already exists.` }
    }
    onChange({ mcpServers: { ...servers, [values.serverKey]: values.config } })
    return { ok: true }
  }

  const handleSaveEdit = (oldKey: string) => async (
    values: McpServerFormValues
  ): Promise<{ ok: boolean; error?: string }> => {
    const newKey = values.serverKey
    if (newKey === oldKey) {
      // Replace in place, preserving position.
      onChange({ mcpServers: { ...servers, [oldKey]: values.config } })
      return { ok: true }
    }
    if (servers[newKey]) {
      return { ok: false, error: `A server with the key "${newKey}" already exists.` }
    }
    // Rename: drop the old key, add the new one.
    const { [oldKey]: _removed, ...rest } = servers
    onChange({ mcpServers: { ...rest, [newKey]: values.config } })
    return { ok: true }
  }

  const handleDelete = (key: string) => () => {
    const { [key]: _removed, ...rest } = servers
    onChange({ mcpServers: rest })
  }

  return (
    <div className="space-y-2">
      {/* Global MCP info banner */}
      <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border)] text-xs text-[var(--text-secondary)]">
        <Info className="h-3.5 w-3.5 text-[var(--accent)] flex-shrink-0" />
        <span>
          Agent-specific MCPs below. Global MCPs (
          <span className="text-[var(--text-primary)] font-medium">{enabledGlobalCount}</span>
          {' '}configured) are also active.
        </span>
        <button
          onClick={() => setShowGlobalMcpManager(true)}
          className="ml-auto flex-shrink-0 text-[var(--accent)] hover:underline font-medium whitespace-nowrap"
        >
          Manage global MCPs →
        </button>
      </div>

      {/* Add button */}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowAddForm(true)}
          disabled={showAddForm}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Add MCP server
        </Button>
      </div>

      {/* Add form */}
      {showAddForm && (
        <McpServerForm
          initial={{ name: '', serverKey: '', config: null, enabled: true }}
          onSave={handleAdd}
          onClose={() => setShowAddForm(false)}
          isDark={isDark}
          showName={false}
          showEnabled={false}
        />
      )}

      {/* Server list */}
      {serverKeys.length === 0 && !showAddForm ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-center">
          <p className="text-xs text-[var(--text-secondary)]">
            No agent-specific MCP servers.
          </p>
          <p className="text-[10px] text-[var(--text-secondary)] opacity-70 mt-1">
            Add one above, or rely on the global MCP servers.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {serverKeys.map((key) => (
            <McpServerRow
              key={key}
              displayName={key}
              serverKey={key}
              config={servers[key]}
              isDark={isDark}
              serverId={serverIdFor(key)}
              isGlobal={false}
              onSave={handleSaveEdit(key)}
              onDelete={handleDelete(key)}
              showName={false}
              showEnabled={false}
              beforeAuth={flushSave}
            />
          ))}
        </div>
      )}
    </div>
  )
}
