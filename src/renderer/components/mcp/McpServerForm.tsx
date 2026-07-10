import React, { useCallback, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { oneDark } from '@codemirror/theme-one-dark'
import { Loader2, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { isUrlMcpServer } from '@shared/mcp'
import type { McpServerEntry, McpOAuthConfig } from '@shared/types'

/** The values a completed MCP server form produces. */
export interface McpServerFormValues {
  name: string
  serverKey: string
  /** Parsed server config with any OAuth fields merged into `config.oauth`. */
  config: McpServerEntry
  enabled: boolean
}

export const DEFAULT_SERVER_CONFIG: McpServerEntry = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
}

const DEFAULT_SERVER_CONFIG_JSON = JSON.stringify(DEFAULT_SERVER_CONFIG, null, 2)

export function parseServerConfig(text: string): { value: McpServerEntry | null; error: string | null } {
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { value: null, error: 'Must be a JSON object' }
    }
    return { value: parsed as McpServerEntry, error: null }
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : 'Invalid JSON' }
  }
}

export function getServerType(config: McpServerEntry): string {
  return isUrlMcpServer(config) ? 'url' : 'stdio'
}

interface FormState {
  name: string
  serverKey: string
  serverConfigText: string
  serverConfigError: string | null
  enabled: boolean
  // OAuth config fields (shown when server config is a URL type)
  oauthClientId: string
  oauthScopes: string // comma-separated
  oauthAuthorizationUrl: string
  oauthTokenUrl: string
  showOAuthSection: boolean
}

function initialFormState(initial: {
  name: string
  serverKey: string
  config: McpServerEntry | null
  enabled: boolean
}): FormState {
  const oauth = initial.config?.oauth
  return {
    name: initial.name,
    serverKey: initial.serverKey,
    serverConfigText: initial.config
      ? JSON.stringify(initial.config, null, 2)
      : DEFAULT_SERVER_CONFIG_JSON,
    serverConfigError: null,
    enabled: initial.enabled,
    oauthClientId: oauth?.clientId ?? '',
    oauthScopes: oauth?.scopes?.join(', ') ?? '',
    oauthAuthorizationUrl: oauth?.authorizationUrl ?? '',
    oauthTokenUrl: oauth?.tokenUrl ?? '',
    showOAuthSection: !!oauth?.clientId,
  }
}

export interface McpServerFormProps {
  initial: { name: string; serverKey: string; config: McpServerEntry | null; enabled: boolean }
  /** Persist the values. Resolve `{ ok: true }` to close, or `{ ok: false, error }` to keep the form open. */
  onSave: (values: McpServerFormValues) => Promise<{ ok: boolean; error?: string }>
  /** Close the form (used both for Cancel and after a successful save). */
  onClose: () => void
  isDark: boolean
  /** Show the "Display Name" field (globals). Off for agents, where the key is the identity. */
  showName?: boolean
  /** Show the "Enabled" checkbox (globals). Off for agents. */
  showEnabled?: boolean
}

/**
 * The inline add/edit form for a single MCP server. Shared by the global MCP
 * manager and the per-agent MCP editor. Config body is a JSON editor; OAuth
 * settings are structured fields shown only for URL-type servers.
 */
export function McpServerForm({
  initial,
  onSave,
  onClose,
  isDark,
  showName = true,
  showEnabled = true,
}: McpServerFormProps) {
  const [form, setForm] = useState<FormState>(() => initialFormState(initial))
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const handleConfigChange = useCallback((val: string) => {
    const { error } = parseServerConfig(val)
    setForm((f) => ({ ...f, serverConfigText: val, serverConfigError: error }))
  }, [])

  // Detect if the current JSON config is URL-type
  const parsedForType = parseServerConfig(form.serverConfigText)
  const isUrlType =
    parsedForType.value !== null &&
    (parsedForType.value.type === 'url' || !!parsedForType.value.url)

  const handleSubmit = async () => {
    const { value, error } = parseServerConfig(form.serverConfigText)
    if (error || !value) {
      setForm((f) => ({ ...f, serverConfigError: error ?? 'Invalid JSON' }))
      return
    }
    if (showName && !form.name.trim()) return
    if (!form.serverKey.trim()) return

    // Merge OAuth config into parsed server config if configured
    let finalConfig: McpServerEntry = value
    if (isUrlType && form.oauthClientId.trim()) {
      const oauthConfig: McpOAuthConfig = {
        clientId: form.oauthClientId.trim(),
        scopes: form.oauthScopes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        authorizationUrl: form.oauthAuthorizationUrl.trim(),
        tokenUrl: form.oauthTokenUrl.trim(),
      }
      finalConfig = { ...value, oauth: oauthConfig }
    } else if (!isUrlType) {
      // Remove oauth if server is no longer URL-type
      const { oauth: _removed, ...rest } = value as McpServerEntry & { oauth?: McpOAuthConfig }
      finalConfig = rest
    }

    const serverKey = form.serverKey.trim()
    setSubmitError(null)
    setSubmitting(true)
    try {
      const res = await onSave({
        name: showName ? form.name.trim() : serverKey,
        serverKey,
        config: finalConfig,
        enabled: form.enabled,
      })
      if (res.ok) {
        onClose()
      } else {
        setSubmitError(res.error ?? 'Save failed')
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const isValid =
    (!showName || form.name.trim().length > 0) &&
    form.serverKey.trim().length > 0 &&
    form.serverConfigError === null

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className={showName ? 'grid grid-cols-2 gap-3' : 'space-y-1'}>
        {showName && (
          <div className="space-y-1">
            <label className="block text-xs font-medium text-[var(--text-secondary)]">
              Display Name
            </label>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="File System Tools"
              autoFocus
            />
          </div>
        )}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Server Key
          </label>
          <Input
            value={form.serverKey}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                serverKey: e.target.value.replace(/\s+/g, '-').toLowerCase(),
              }))
            }
            placeholder="filesystem"
            className="font-mono"
            autoFocus={!showName}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Server Config (JSON)
        </label>
        <div className="rounded-md border border-[var(--border)] overflow-hidden text-xs">
          <CodeMirror
            value={form.serverConfigText}
            height="160px"
            extensions={[json()]}
            theme={isDark ? oneDark : undefined}
            onChange={handleConfigChange}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
              autocompletion: true,
            }}
          />
        </div>
        {form.serverConfigError && (
          <p className="text-xs text-red-400">
            <span className="font-medium">JSON error:</span> {form.serverConfigError}
          </p>
        )}
      </div>

      {/* OAuth Configuration — only shown for URL-type servers */}
      {isUrlType && (
        <div className="border border-[var(--border)] rounded-md overflow-hidden">
          <button
            type="button"
            onClick={() => setForm((f) => ({ ...f, showOAuthSection: !f.showOAuthSection }))}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] transition-colors"
          >
            {form.showOAuthSection ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            OAuth Configuration
            <span className="ml-auto font-normal opacity-60">optional</span>
          </button>

          {form.showOAuthSection && (
            <div className="px-3 pb-3 pt-1 space-y-2.5 border-t border-[var(--border)]">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-[var(--text-secondary)]">
                  Client ID
                </label>
                <Input
                  value={form.oauthClientId}
                  onChange={(e) => setForm((f) => ({ ...f, oauthClientId: e.target.value }))}
                  placeholder="your-client-id"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-[var(--text-secondary)]">
                  Scopes <span className="font-normal opacity-60">(comma-separated)</span>
                </label>
                <Input
                  value={form.oauthScopes}
                  onChange={(e) => setForm((f) => ({ ...f, oauthScopes: e.target.value }))}
                  placeholder="read write offline_access"
                  className="text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-[var(--text-secondary)]">
                  Authorization URL{' '}
                  <span className="font-normal opacity-60">(override discovery)</span>
                </label>
                <Input
                  value={form.oauthAuthorizationUrl}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, oauthAuthorizationUrl: e.target.value }))
                  }
                  placeholder="https://auth.example.com/oauth/authorize"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-[var(--text-secondary)]">
                  Token URL <span className="font-normal opacity-60">(override discovery)</span>
                </label>
                <Input
                  value={form.oauthTokenUrl}
                  onChange={(e) => setForm((f) => ({ ...f, oauthTokenUrl: e.target.value }))}
                  placeholder="https://auth.example.com/oauth/token"
                  className="font-mono text-xs"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {showEnabled && (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="form-enabled"
            checked={form.enabled}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            className="rounded border-[var(--border)] accent-[var(--accent)]"
          />
          <label htmlFor="form-enabled" className="text-xs text-[var(--text-secondary)] cursor-pointer">
            Enabled
          </label>
        </div>
      )}

      {submitError && (
        <div className="text-xs px-3 py-2 rounded-md bg-red-500/10 text-red-400 border border-red-500/20">
          {submitError}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={!isValid || submitting}>
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save
        </Button>
      </div>
    </div>
  )
}
