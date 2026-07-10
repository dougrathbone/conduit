import React, { useState } from 'react'
import { Pencil, Trash2, Loader2, X, Check, RefreshCw, Share2 } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useMcpHealth } from '@renderer/hooks/useMcpHealth'
import { useMcpTools } from '@renderer/hooks/useMcpTools'
import { useMcpOAuthProbe } from '@renderer/hooks/useMcpOAuth'
import { McpOAuthButton } from '@renderer/components/settings/McpOAuthButton'
import type { McpServerEntry } from '@shared/types'
import { McpServerForm, getServerType, type McpServerFormValues } from './McpServerForm'

function McpHealthDot({
  serverId,
  serverConfig,
  onNeedsAuth,
}: {
  serverId: string
  serverConfig: McpServerEntry
  onNeedsAuth?: (serverId: string, config: McpServerEntry) => void
}) {
  const { data, isLoading, isFetching, refetch } = useMcpHealth(serverId, serverConfig)

  const pending = isLoading || isFetching
  const color = pending
    ? '#F59E0B'
    : data?.status === 'healthy'
    ? '#22C55E'
    : data?.status === 'unauthorized'
    ? '#F59E0B'
    : '#EF4444'

  const label = pending
    ? 'Checking…'
    : data?.status === 'healthy'
    ? `Connected · ${data.message}`
    : data?.status === 'unauthorized'
    ? `Authentication required · ${data.message}`
    : `Not connected · ${data?.message ?? 'Unknown error'}`

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const res = await refetch()
    // If the server needs authentication, launch the OAuth flow (globals only).
    if (res.data?.status === 'unauthorized') {
      onNeedsAuth?.(serverId, serverConfig)
    }
  }

  return (
    <button
      onClick={handleRefresh}
      title={label}
      className="flex items-center gap-1 flex-shrink-0 group"
      aria-label={label}
    >
      <span
        className={cn('inline-block w-2 h-2 rounded-full transition-colors', pending && 'animate-pulse')}
        style={{ backgroundColor: color }}
      />
      <RefreshCw className="h-2.5 w-2.5 text-[var(--text-secondary)] opacity-0 group-hover:opacity-60 transition-opacity" />
    </button>
  )
}

function McpToolCount({ serverId, serverConfig }: { serverId: string; serverConfig: McpServerEntry }) {
  const { data, isLoading } = useMcpTools(serverId, serverConfig)

  if (isLoading) return <span className="text-[10px] text-[var(--text-secondary)] opacity-50">loading tools…</span>
  if (!data || data.error) return null
  if (data.tools.length === 0) return null

  const toolNames = data.tools.map((t) => t.name).join('\n')

  return (
    <span className="text-[10px] text-[var(--accent)] opacity-80" title={toolNames}>
      {data.tools.length} tool{data.tools.length !== 1 ? 's' : ''} available
    </span>
  )
}

export interface McpServerRowProps {
  displayName: string
  serverKey: string
  config: McpServerEntry
  isDark: boolean
  /** Stable identity for health/tools/OAuth. Global: server.id. Agent: "{agentId}:{serverKey}". */
  serverId: string
  isGlobal: boolean
  /** Persist an edit. Resolve `{ ok: false, error }` to keep the form open. */
  onSave: (values: McpServerFormValues) => Promise<{ ok: boolean; error?: string }>
  /** Remove the server. */
  onDelete: () => Promise<void> | void
  deleting?: boolean
  /** Enable toggle — rendered only when `enabled` is defined (globals). Agents omit it. */
  enabled?: boolean
  onToggleEnabled?: () => void
  toggling?: boolean
  /** Share button — rendered only when provided (globals, owner). */
  onShare?: () => void
  /** Form field visibility passed through to the edit form. */
  showName?: boolean
  showEnabled?: boolean
  /** Flush pending persistence before starting OAuth (agents auto-save on a debounce). */
  beforeAuth?: () => Promise<void> | void
  /** Health-dot auto-kick when a server reports unauthorized (globals only). */
  onNeedsAuth?: (serverId: string, config: McpServerEntry) => void
}

/**
 * One MCP server list item, shared by the global MCP manager and the per-agent
 * MCP editor. Read mode shows the enable toggle (when applicable), name/key/type,
 * tool count, health dot, OAuth button, and share/edit/delete actions. Editing
 * swaps in the shared `McpServerForm`.
 */
export function McpServerRow({
  displayName,
  serverKey,
  config,
  isDark,
  serverId,
  isGlobal,
  onSave,
  onDelete,
  deleting,
  enabled,
  onToggleEnabled,
  toggling,
  onShare,
  showName,
  showEnabled,
  beforeAuth,
  onNeedsAuth,
}: McpServerRowProps) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const probe = useMcpOAuthProbe(config)

  const hasToggle = enabled !== undefined
  const isEnabled = enabled ?? true
  const serverType = getServerType(config)

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    void onDelete()
  }

  if (editing) {
    return (
      <McpServerForm
        initial={{ name: displayName, serverKey, config, enabled: isEnabled }}
        onSave={onSave}
        onClose={() => setEditing(false)}
        isDark={isDark}
        showName={showName}
        showEnabled={showEnabled}
      />
    )
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors',
        isEnabled
          ? 'border-[var(--border)] bg-[var(--bg-secondary)]'
          : 'border-[var(--border)] bg-[var(--bg-primary)] opacity-60'
      )}
    >
      {/* Toggle (globals only) */}
      {hasToggle && (
        <button
          onClick={onToggleEnabled}
          disabled={toggling}
          title={isEnabled ? 'Disable' : 'Enable'}
          className={cn(
            'w-4 h-4 rounded-full border-2 flex-shrink-0 transition-colors',
            isEnabled
              ? 'bg-[var(--accent)] border-[var(--accent)]'
              : 'bg-transparent border-[var(--text-secondary)]'
          )}
          aria-label={isEnabled ? 'Disable server' : 'Enable server'}
        />
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)] truncate">
          {displayName}
          {hasToggle && !isEnabled && (
            <span className="ml-2 text-xs text-[var(--text-secondary)] font-normal">(disabled)</span>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[var(--text-secondary)] font-mono truncate">
            {serverKey} · {serverType}
          </span>
          {isEnabled && (
            <>
              <span className="text-[var(--text-secondary)] opacity-30">·</span>
              <McpToolCount serverId={serverId} serverConfig={config} />
            </>
          )}
        </div>
      </div>

      {/* Health indicator */}
      {isEnabled && <McpHealthDot serverId={serverId} serverConfig={config} onNeedsAuth={onNeedsAuth} />}

      {/* OAuth button for URL-type servers — shown when oauth block present or probe detects support */}
      {serverType === 'url' && config.url && (config.oauth || probe.data?.supportsOAuth) && (
        <McpOAuthButton
          serverId={serverId}
          isGlobal={isGlobal}
          serverUrl={config.url}
          serverName={displayName}
          beforeAuth={beforeAuth}
        />
      )}

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {onShare && (
          <button
            onClick={onShare}
            className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] transition-colors"
            title="Share"
          >
            <Share2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={() => {
            setEditing(true)
            setConfirmDelete(false)
          }}
          className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] transition-colors"
          title="Edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        {confirmDelete ? (
          <>
            <span className="text-xs text-red-400 ml-1">Delete?</span>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="p-1.5 rounded-md text-red-400 hover:bg-red-400/10 transition-colors"
              title="Confirm delete"
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] transition-colors"
              title="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <button
            onClick={handleDelete}
            className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-red-400/10 hover:text-red-400 transition-colors"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
