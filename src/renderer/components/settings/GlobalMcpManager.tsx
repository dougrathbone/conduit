import React, { useState } from 'react'
import { Plus, Info, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { ShareDialog } from '@renderer/components/ShareDialog'
import { useUIStore } from '@renderer/store/ui'
import {
  useGlobalMcps,
  useCreateGlobalMcp,
  useUpdateGlobalMcp,
  useDeleteGlobalMcp,
} from '@renderer/hooks/useGlobalMcps'
import { useAuth } from '@renderer/contexts/AuthContext'
import { useToast } from '@renderer/contexts/ToastContext'
import { api } from '@renderer/lib/ipc'
import { isUrlMcpServer } from '@shared/mcp'
import type { GlobalMcpServer, McpServerEntry } from '@shared/types'
import { McpServerForm, type McpServerFormValues } from '@renderer/components/mcp/McpServerForm'
import { McpServerRow } from '@renderer/components/mcp/McpServerRow'

/**
 * If a URL MCP server supports OAuth and isn't *actually* connected, start the
 * auth flow and open the authorization window. "Connected" is judged by the
 * token-aware health check (a real authenticated request) rather than by whether
 * a token row merely exists — so a stale/invalid/shared-URL token still prompts
 * a login. No-op for stdio/non-OAuth servers or ones that authenticate cleanly.
 * Best-effort — the popup may be blocked, so the Authenticate button remains as
 * the reliable fallback. Global-only: hardcodes `isGlobal=true`.
 */
async function maybeKickOAuth(serverId: string, cfg: McpServerEntry) {
  if (!isUrlMcpServer(cfg)) return
  try {
    const probe = cfg.oauth ? { supportsOAuth: true } : await api.mcpOAuth.probe(cfg)
    if (!probe.supportsOAuth) return
    // Source of truth: does an authenticated request actually succeed?
    const health = await api.globalMcps.checkHealth(cfg)
    if (health.status === 'healthy') return
    const { authUrl } = await api.mcpOAuth.startAuth(serverId, true, window.location.origin)
    const win = window.open(authUrl, '_blank', 'noopener,noreferrer')
    if (!win) {
      // Popup blocked — the Authenticate button remains as the reliable fallback.
      console.warn('[mcp] OAuth popup was blocked by the browser; use the Authenticate button.')
    }
  } catch (err) {
    // Surface the failure (was previously silent) so auth problems are diagnosable.
    console.error('[mcp] failed to start OAuth flow:', err)
  }
}

interface GlobalServerRowProps {
  server: GlobalMcpServer
  isDark: boolean
  isOwner: boolean
  onShare: () => void
}

function GlobalServerRow({ server, isDark, isOwner, onShare }: GlobalServerRowProps) {
  const toast = useToast()
  const updateMcp = useUpdateGlobalMcp()
  const deleteMcp = useDeleteGlobalMcp()

  const handleToggle = () => {
    updateMcp.mutate(
      { id: server.id, data: { enabled: !server.enabled } },
      {
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : String(err))
        },
      }
    )
  }

  const handleSave = async (values: McpServerFormValues): Promise<{ ok: boolean; error?: string }> => {
    try {
      const saved = await updateMcp.mutateAsync({
        id: server.id,
        data: {
          name: values.name,
          serverKey: values.serverKey,
          serverConfig: values.config,
          enabled: values.enabled,
        },
      })
      void maybeKickOAuth(saved.id, saved.serverConfig)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const handleDelete = () => {
    deleteMcp.mutate(server.id, {
      onSuccess: () => {
        toast.success('MCP server deleted')
      },
      onError: (err) => {
        // The mutation rejects with `new Error(msg.error)` (see ws-client), so the
        // server's message (e.g. "Only the owner can delete this MCP server") is
        // surfaced verbatim.
        toast.error(err instanceof Error ? err.message : String(err))
      },
    })
  }

  return (
    <McpServerRow
      displayName={server.name}
      serverKey={server.serverKey}
      config={server.serverConfig}
      isDark={isDark}
      serverId={server.id}
      isGlobal
      enabled={server.enabled}
      onToggleEnabled={handleToggle}
      toggling={updateMcp.isPending}
      onSave={handleSave}
      onDelete={handleDelete}
      deleting={deleteMcp.isPending}
      onShare={isOwner ? onShare : undefined}
      onNeedsAuth={maybeKickOAuth}
    />
  )
}

export function GlobalMcpManager() {
  const { theme } = useUIStore()
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const { data: servers = [], isLoading } = useGlobalMcps()
  const { user } = useAuth()
  const createMcp = useCreateGlobalMcp()

  const [showAddForm, setShowAddForm] = useState(false)
  const [shareServerId, setShareServerId] = useState<string | null>(null)

  const handleCreate = async (values: McpServerFormValues): Promise<{ ok: boolean; error?: string }> => {
    try {
      const saved = await createMcp.mutateAsync({
        name: values.name,
        serverKey: values.serverKey,
        serverConfig: values.config,
        enabled: values.enabled,
      })
      void maybeKickOAuth(saved.id, saved.serverConfig)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // Legacy single-user-mode globals (null owner, or the synthetic dev user) are
  // org-wide and owned by nobody real — any authenticated user may manage/delete
  // them (mirrors the server's globalMcps:delete rule). Treat them as owner-managed
  // in the UI so they surface a delete button instead of being stuck under
  // "Shared with Me" with no way to remove them.
  const isLegacyGlobal = (s: { ownerId?: string | null }) => s.ownerId == null || s.ownerId === 'dev-user'
  const myServers = servers.filter((s) => s.ownerId === user?.id)
  const sharedServers = servers.filter((s) => s.ownerId !== user?.id)

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">Global MCP Servers</h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">Shared across all agents</p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowAddForm(true)}
          disabled={showAddForm}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {/* Info banner */}
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-xs text-[var(--text-secondary)]">
          <Info className="h-3.5 w-3.5 text-[var(--accent)] flex-shrink-0 mt-0.5" />
          <span>
            Global MCPs are merged with agent-specific MCPs on every run. Agent MCPs take priority
            if keys conflict.
          </span>
        </div>

        {/* Add form */}
        {showAddForm && (
          <McpServerForm
            initial={{ name: '', serverKey: '', config: null, enabled: true }}
            onSave={handleCreate}
            onClose={() => setShowAddForm(false)}
            isDark={isDark}
          />
        )}

        {/* Server list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-sm text-[var(--text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading…
          </div>
        ) : servers.length === 0 && !showAddForm ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
            <p className="text-sm text-[var(--text-secondary)]">No global MCP servers configured.</p>
            <p className="text-xs text-[var(--text-secondary)] max-w-xs">
              Add shared MCP servers here and they&apos;ll be automatically available to every agent.
            </p>
            <Button size="sm" variant="outline" className="mt-2 gap-1.5" onClick={() => setShowAddForm(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add your first global MCP
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {myServers.length > 0 && (
              <>
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] px-3 py-1.5">
                  My Servers <span className="ml-1 opacity-60">{myServers.length}</span>
                </div>
                {myServers.map((server) => (
                  <GlobalServerRow key={server.id} server={server} isDark={isDark} isOwner onShare={() => setShareServerId(server.id)} />
                ))}
              </>
            )}
            {sharedServers.length > 0 && (
              <>
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] px-3 py-1.5">
                  Shared with Me <span className="ml-1 opacity-60">{sharedServers.length}</span>
                </div>
                {sharedServers.map((server) => (
                  <GlobalServerRow key={server.id} server={server} isDark={isDark} isOwner={isLegacyGlobal(server)} onShare={() => setShareServerId(server.id)} />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {shareServerId && (
        <ShareDialog
          entityType="globalMcpServer"
          entityId={shareServerId}
          isOpen={!!shareServerId}
          onClose={() => setShareServerId(null)}
        />
      )}
    </div>
  )
}
