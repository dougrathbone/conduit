import React, { useState } from 'react'
import { Plus, Pencil, Trash2, Info, Loader2, X, Check, RefreshCw, FolderGit2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  useRepositories,
  useCreateRepository,
  useUpdateRepository,
  useDeleteRepository,
  useTriggerRepoSync,
  useRepoSyncEvents,
} from '@renderer/hooks/useRepositories'
import { cn } from '@renderer/lib/utils'
import type { Repository, RepoSyncStatus } from '@shared/types'

function statusColor(status: RepoSyncStatus): string {
  switch (status) {
    case 'ready': return 'bg-green-500'
    case 'cloning':
    case 'syncing': return 'bg-yellow-500'
    case 'error': return 'bg-red-500'
    case 'pending':
    default: return 'bg-[var(--text-secondary)]'
  }
}

function statusLabel(status: RepoSyncStatus): string {
  switch (status) {
    case 'ready': return 'Ready'
    case 'cloning': return 'Cloning...'
    case 'syncing': return 'Syncing...'
    case 'error': return 'Error'
    case 'pending': return 'Pending'
    default: return status
  }
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

interface FormState {
  name: string
  url: string
  defaultBranch: string
  authMethod: 'none' | 'pat' | 'ssh'
}

function emptyForm(): FormState {
  return { name: '', url: '', defaultBranch: 'main', authMethod: 'none' }
}

function formFromRepo(repo: Repository): FormState {
  return {
    name: repo.name,
    url: repo.url,
    defaultBranch: repo.defaultBranch,
    authMethod: repo.authMethod,
  }
}

interface InlineFormProps {
  initial: FormState
  onSave: (form: FormState) => void
  onCancel: () => void
  saving: boolean
}

function InlineForm({ initial, onSave, onCancel, saving }: InlineFormProps) {
  const [form, setForm] = useState<FormState>(initial)

  const isValid = form.name.trim().length > 0 && form.url.trim().length > 0 && form.defaultBranch.trim().length > 0

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--bg-secondary)] p-4 space-y-4">
      {/* Name */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Repository Name
        </label>
        <Input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="e.g. conduit"
          autoFocus
        />
      </div>

      {/* Clone URL */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Clone URL
        </label>
        <Input
          value={form.url}
          onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
          placeholder="https://github.com/org/repo.git"
          className="font-mono text-xs"
        />
      </div>

      {/* Default Branch */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Default Branch
        </label>
        <Input
          value={form.defaultBranch}
          onChange={(e) => setForm((f) => ({ ...f, defaultBranch: e.target.value }))}
          placeholder="main"
          className="text-xs w-48"
        />
      </div>

      {/* Auth Method */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Authentication
        </label>
        <div className="flex gap-1 p-0.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border)]">
          {(['none', 'pat', 'ssh'] as const).map((method) => (
            <button
              key={method}
              type="button"
              onClick={() => setForm((f) => ({ ...f, authMethod: method }))}
              className={cn(
                'flex-1 text-xs py-1.5 rounded-md transition-colors font-medium',
                form.authMethod === method
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              )}
            >
              {method === 'none' ? 'None' : method === 'pat' ? 'PAT' : 'SSH'}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
          {form.authMethod === 'pat'
            ? 'Uses your configured GitHub PAT (same as Gist auth).'
            : form.authMethod === 'ssh'
            ? 'Uses your system SSH agent. Ensure your key is loaded.'
            : 'No authentication — for public repositories only.'}
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => onSave(form)} disabled={!isValid || saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save
        </Button>
      </div>
    </div>
  )
}

interface RepoRowProps {
  repo: Repository
}

function RepoRow({ repo }: RepoRowProps) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const updateRepo = useUpdateRepository()
  const deleteRepo = useDeleteRepository()
  const triggerSync = useTriggerRepoSync()

  const handleSave = (form: FormState) => {
    updateRepo.mutate(
      {
        id: repo.id,
        data: {
          name: form.name.trim(),
          url: form.url.trim(),
          defaultBranch: form.defaultBranch.trim(),
          authMethod: form.authMethod,
        },
      },
      { onSuccess: () => setEditing(false) }
    )
  }

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    deleteRepo.mutate(repo.id)
  }

  if (editing) {
    return (
      <InlineForm
        initial={formFromRepo(repo)}
        onSave={handleSave}
        onCancel={() => setEditing(false)}
        saving={updateRepo.isPending}
      />
    )
  }

  const isBusy = repo.syncStatus === 'cloning' || repo.syncStatus === 'syncing'

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] transition-colors">
      {/* Status dot */}
      <div
        className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', statusColor(repo.syncStatus))}
        title={statusLabel(repo.syncStatus)}
      />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-[var(--text-primary)] truncate">
            {repo.name}
          </p>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)] font-mono flex-shrink-0">
            {repo.defaultBranch}
          </span>
        </div>
        <p className="text-xs text-[var(--text-secondary)] truncate font-mono">
          {repo.url}
        </p>
        {repo.syncStatus === 'error' && repo.syncError && (
          <p className="text-xs text-red-400 truncate mt-0.5">
            {repo.syncError}
          </p>
        )}
        {repo.lastSyncedAt && (
          <p className="text-[10px] text-[var(--text-secondary)] opacity-60 mt-0.5">
            Synced {formatRelativeTime(repo.lastSyncedAt)}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={() => triggerSync.mutate(repo.id)}
          disabled={isBusy || triggerSync.isPending}
          className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
          title="Sync now"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isBusy && 'animate-spin')} />
        </button>
        <button
          onClick={() => { setEditing(true); setConfirmDelete(false) }}
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
              disabled={deleteRepo.isPending}
              className="p-1.5 rounded-md text-red-400 hover:bg-red-400/10 transition-colors"
              title="Confirm delete"
            >
              {deleteRepo.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
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

export function RepositoryManager() {
  const { data: repos = [], isLoading } = useRepositories()
  const createRepo = useCreateRepository()
  useRepoSyncEvents()

  const [showAddForm, setShowAddForm] = useState(false)

  const handleCreate = (form: FormState) => {
    createRepo.mutate(
      {
        name: form.name.trim(),
        url: form.url.trim(),
        defaultBranch: form.defaultBranch.trim(),
        authMethod: form.authMethod,
      },
      { onSuccess: () => setShowAddForm(false) }
    )
  }

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">Repositories</h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            Git repositories for agent workspaces
          </p>
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
            Repositories are cloned and kept up-to-date in the background. Assign a repo to an agent
            and each run gets an isolated worktree — no manual cloning needed.
          </span>
        </div>

        {/* Add form */}
        {showAddForm && (
          <InlineForm
            initial={emptyForm()}
            onSave={handleCreate}
            onCancel={() => setShowAddForm(false)}
            saving={createRepo.isPending}
          />
        )}

        {/* Repo list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-sm text-[var(--text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading...
          </div>
        ) : repos.length === 0 && !showAddForm ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
            <div className="w-12 h-12 rounded-xl bg-[var(--accent)]/10 flex items-center justify-center mb-2">
              <FolderGit2 className="h-6 w-6 text-[var(--accent)] opacity-60" />
            </div>
            <p className="text-sm text-[var(--text-secondary)]">No repositories configured.</p>
            <p className="text-xs text-[var(--text-secondary)] max-w-xs">
              Add a git repository to provide managed workspaces for your agents.
            </p>
            <Button size="sm" variant="outline" className="mt-2 gap-1.5" onClick={() => setShowAddForm(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add your first repository
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {repos.map((repo) => (
              <RepoRow key={repo.id} repo={repo} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
