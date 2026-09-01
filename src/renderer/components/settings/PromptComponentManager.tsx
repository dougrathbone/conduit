import React, { useState } from 'react'
import { Plus, Pencil, Trash2, Info, Loader2, X, Check, Share2, FileText, ScrollText } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ShareDialog } from '@renderer/components/ShareDialog'
import {
  useGlobalPromptComponents,
  useCreateGlobalPromptComponent,
  useUpdateGlobalPromptComponent,
  useDeleteGlobalPromptComponent,
} from '@renderer/hooks/useGlobalPromptComponents'
import { useAuth } from '@renderer/contexts/AuthContext'
import { useToast } from '@renderer/contexts/ToastContext'
import { cn } from '@renderer/lib/utils'
import type { GlobalPromptComponent, GlobalPromptComponentKind } from '@shared/types'

interface FormState {
  name: string
  kind: GlobalPromptComponentKind
  content: string
  filePath: string
  enabled: boolean
}

const emptyForm = (): FormState => ({
  name: '',
  kind: 'instruction',
  content: '',
  filePath: '',
  enabled: true,
})

function formFrom(item: GlobalPromptComponent): FormState {
  return {
    name: item.name,
    kind: item.kind,
    content: item.content,
    filePath: item.filePath ?? '',
    enabled: item.enabled,
  }
}

function ComponentForm({
  initial,
  onSave,
  onClose,
  saving,
}: {
  initial: FormState
  onSave: (values: FormState) => Promise<{ ok: boolean; error?: string }>
  onClose: () => void
  saving: boolean
}) {
  const [form, setForm] = useState(initial)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const result = await onSave(form)
    if (result.ok) onClose()
    else setError(result.error ?? 'Save failed')
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-[var(--border)] px-4 py-3.5 space-y-3"
      style={{ background: 'var(--bg-secondary)' }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--text-primary)]">
          {initial.name ? 'Edit component' : 'New component'}
        </span>
        <button type="button" onClick={onClose} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">Name</span>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="House style"
            required
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">Type</span>
          <div className="flex gap-1 p-0.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)]">
            {(['instruction', 'file'] as GlobalPromptComponentKind[]).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setForm({ ...form, kind })}
                className={cn(
                  'flex-1 h-7 rounded text-xs font-medium capitalize transition-colors',
                  form.kind === kind
                    ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                )}
              >
                {kind}
              </button>
            ))}
          </div>
        </label>
      </div>

      {form.kind === 'file' && (
        <label className="space-y-1 block">
          <span className="text-xs text-[var(--text-secondary)]">Workspace path</span>
          <Input
            value={form.filePath}
            onChange={(e) => setForm({ ...form, filePath: e.target.value })}
            placeholder="CLAUDE.md or .cursor/rules/org.mdc"
            required
          />
          <span className="text-[10px] text-[var(--text-secondary)]">
            Relative to the run workspace. Written on every run so CLIs can pick it up.
          </span>
        </label>
      )}

      <label className="space-y-1 block">
        <span className="text-xs text-[var(--text-secondary)]">
          {form.kind === 'file' ? 'File contents' : 'Instructions'}
        </span>
        <textarea
          value={form.content}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
          rows={10}
          placeholder={
            form.kind === 'file'
              ? 'Contents written into the workspace file (and included in the prompt).'
              : 'These instructions are prepended to every agent prompt.'
          }
          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-[var(--accent)]"
        />
      </label>

      <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          className="rounded border-[var(--border)]"
        />
        Enabled — inject on every run
      </label>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving} className="gap-1.5">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save
        </Button>
      </div>
    </form>
  )
}

function ComponentRow({
  item,
  isOwner,
  onShare,
}: {
  item: GlobalPromptComponent
  isOwner: boolean
  onShare: () => void
}) {
  const toast = useToast()
  const update = useUpdateGlobalPromptComponent()
  const remove = useDeleteGlobalPromptComponent()
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <ComponentForm
        initial={formFrom(item)}
        saving={update.isPending}
        onClose={() => setEditing(false)}
        onSave={async (values) => {
          try {
            await update.mutateAsync({
              id: item.id,
              data: {
                name: values.name,
                kind: values.kind,
                content: values.content,
                filePath: values.kind === 'file' ? values.filePath : undefined,
                enabled: values.enabled,
              },
            })
            return { ok: true }
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        }}
      />
    )
  }

  return (
    <div
      className="rounded-lg border border-[var(--border)] px-4 py-3 flex items-start gap-3"
      style={{ background: 'var(--bg-secondary)' }}
    >
      <div
        className={cn(
          'mt-0.5 flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center',
          item.enabled ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'bg-[var(--bg-primary)] text-[var(--text-secondary)]'
        )}
      >
        {item.kind === 'file' ? <FileText className="h-3.5 w-3.5" /> : <ScrollText className="h-3.5 w-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text-primary)] truncate">{item.name}</span>
          <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{item.kind}</span>
          {!item.enabled && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)]">
              Off
            </span>
          )}
        </div>
        {item.kind === 'file' && item.filePath && (
          <code className="text-[11px] text-[var(--text-secondary)]">{item.filePath}</code>
        )}
        <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2 whitespace-pre-wrap">
          {item.content.trim() || '(empty)'}
        </p>
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <button
          type="button"
          title={item.enabled ? 'Disable' : 'Enable'}
          onClick={() =>
            update.mutate(
              { id: item.id, data: { enabled: !item.enabled } },
              { onError: (err) => toast.error(err instanceof Error ? err.message : String(err)) }
            )
          }
          className={cn(
            'h-7 px-2 rounded text-[10px] font-medium',
            item.enabled ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
          )}
        >
          {item.enabled ? 'On' : 'Off'}
        </button>
        <Button variant="ghost" size="sm" className="px-1.5" title="Edit" onClick={() => setEditing(true)}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        {isOwner && (
          <Button variant="ghost" size="sm" className="px-1.5" title="Share" onClick={onShare}>
            <Share2 className="h-3.5 w-3.5" />
          </Button>
        )}
        {isOwner && (
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5 text-[var(--text-secondary)] hover:text-red-400"
            title="Delete"
            disabled={remove.isPending}
            onClick={() => {
              if (!window.confirm(`Delete "${item.name}"? It will no longer be added to runs.`)) return
              remove.mutate(item.id, {
                onSuccess: () => toast.success('Prompt component deleted'),
                onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
              })
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

export function PromptComponentManager() {
  const { data: items = [], isLoading } = useGlobalPromptComponents()
  const { user } = useAuth()
  const create = useCreateGlobalPromptComponent()
  const [showAdd, setShowAdd] = useState(false)
  const [shareId, setShareId] = useState<string | null>(null)

  const isLegacyGlobal = (s: { ownerId?: string | null }) => s.ownerId == null || s.ownerId === 'dev-user'
  const mine = items.filter((s) => s.ownerId === user?.id)
  const shared = items.filter((s) => s.ownerId !== user?.id)

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">Prompt components</h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">Added to every agent run</p>
        </div>
        <Button size="sm" onClick={() => setShowAdd(true)} disabled={showAdd} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-xs text-[var(--text-secondary)]">
          <Info className="h-3.5 w-3.5 text-[var(--accent)] flex-shrink-0 mt-0.5" />
          <span>
            <strong className="text-[var(--text-primary)]">Instructions</strong> are prepended to every agent prompt.
            <strong className="text-[var(--text-primary)]"> Files</strong> are written into the run workspace (and also
            included in the prompt). Enabled items apply to all runs; share an item so others can view or edit it.
          </span>
        </div>

        {showAdd && (
          <ComponentForm
            initial={emptyForm()}
            saving={create.isPending}
            onClose={() => setShowAdd(false)}
            onSave={async (values) => {
              try {
                await create.mutateAsync({
                  name: values.name,
                  kind: values.kind,
                  content: values.content,
                  filePath: values.kind === 'file' ? values.filePath : undefined,
                  enabled: values.enabled,
                })
                return { ok: true }
              } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) }
              }
            }}
          />
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-sm text-[var(--text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading…
          </div>
        ) : items.length === 0 && !showAdd ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
            <p className="text-sm text-[var(--text-secondary)]">No Conduit-wide instructions or files yet.</p>
            <p className="text-xs text-[var(--text-secondary)] max-w-xs">
              Add house style, org rules, or a CLAUDE.md / AGENTS.md that every agent should see.
            </p>
            <Button size="sm" variant="outline" className="mt-2 gap-1.5" onClick={() => setShowAdd(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add your first component
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {mine.length > 0 && (
              <>
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] px-3 py-1.5">
                  Mine <span className="ml-1 opacity-60">{mine.length}</span>
                </div>
                {mine.map((item) => (
                  <ComponentRow key={item.id} item={item} isOwner onShare={() => setShareId(item.id)} />
                ))}
              </>
            )}
            {shared.length > 0 && (
              <>
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] px-3 py-1.5">
                  Shared with me <span className="ml-1 opacity-60">{shared.length}</span>
                </div>
                {shared.map((item) => (
                  <ComponentRow
                    key={item.id}
                    item={item}
                    isOwner={isLegacyGlobal(item)}
                    onShare={() => setShareId(item.id)}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {shareId && (
        <ShareDialog
          entityType="globalPromptComponent"
          entityId={shareId}
          isOpen={!!shareId}
          onClose={() => setShareId(null)}
        />
      )}
    </div>
  )
}
