import React, { useState } from 'react'
import { Plus, Pencil, Trash2, Info, Loader2, X, Check, Send } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  usePublishTargets,
  useCreatePublishTarget,
  useUpdatePublishTarget,
  useDeletePublishTarget,
  useTestPublishTarget,
} from '@renderer/hooks/usePublishTargets'
import { cn } from '@renderer/lib/utils'
import type { PublishTarget, SlackPublishConfig } from '@shared/types'

interface FormState {
  name: string
  botToken: string
  webhookUrl: string
  channel: string
  iconEmoji: string
  enabled: boolean
}

function emptyForm(): FormState {
  return {
    name: '',
    botToken: '',
    webhookUrl: '',
    channel: '',
    iconEmoji: ':robot_face:',
    enabled: true,
  }
}

function formFromTarget(target: PublishTarget): FormState {
  return {
    name: target.name,
    botToken: target.config.botToken ?? '',
    webhookUrl: target.config.webhookUrl ?? '',
    channel: target.config.channel,
    iconEmoji: target.config.iconEmoji ?? ':robot_face:',
    enabled: target.enabled,
  }
}

function formToConfig(form: FormState): SlackPublishConfig {
  return {
    botToken: form.botToken.trim() || undefined,
    webhookUrl: form.webhookUrl.trim() || undefined,
    channel: form.channel.trim(),
    iconEmoji: form.iconEmoji.trim() || undefined,
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
  const testMutation = useTestPublishTarget()

  const hasAuth = form.botToken.trim() || form.webhookUrl.trim()
  const hasChannel = form.botToken.trim() ? form.channel.trim() : true
  const canTest = !!hasAuth && !!hasChannel
  const isValid = form.name.trim().length > 0 && canTest

  const handleTest = () => {
    testMutation.reset()
    testMutation.mutate(formToConfig(form))
  }

  const mode = form.webhookUrl.trim() ? 'webhook' : 'bot'

  const testError = testMutation.error
    ? testMutation.error instanceof Error ? testMutation.error.message : String(testMutation.error)
    : testMutation.data && !testMutation.data.success
    ? testMutation.data.error
    : null

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--bg-secondary)] p-4 space-y-4">
      {/* Name */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Target Name
        </label>
        <Input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="e.g. #eng-alerts Slack"
          autoFocus
        />
      </div>

      {/* Auth mode tabs */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Authentication
        </label>
        <div className="flex gap-1 p-0.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border)]">
          <button
            type="button"
            onClick={() => setForm((f) => ({ ...f, webhookUrl: '', botToken: f.botToken }))}
            className={cn(
              'flex-1 text-xs py-1.5 rounded-md transition-colors font-medium',
              mode === 'bot'
                ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            )}
          >
            Bot Token
          </button>
          <button
            type="button"
            onClick={() => setForm((f) => ({ ...f, botToken: '', webhookUrl: f.webhookUrl }))}
            className={cn(
              'flex-1 text-xs py-1.5 rounded-md transition-colors font-medium',
              mode === 'webhook'
                ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            )}
          >
            Webhook URL
          </button>
        </div>

        {mode === 'bot' ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-xs text-[var(--text-secondary)]">
                Bot User OAuth Token
              </label>
              <Input
                value={form.botToken}
                onChange={(e) => setForm((f) => ({ ...f, botToken: e.target.value }))}
                placeholder="xoxb-..."
                className="font-mono text-xs"
                type="password"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs text-[var(--text-secondary)]">
                Channel ID
              </label>
              <Input
                value={form.channel}
                onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value }))}
                placeholder="C0123456789"
                className="font-mono text-xs"
              />
              <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
                Right-click a channel in Slack → View channel details → copy the ID at the bottom.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <label className="block text-xs text-[var(--text-secondary)]">
              Incoming Webhook URL
            </label>
            <Input
              value={form.webhookUrl}
              onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
              placeholder="https://hooks.slack.com/services/T.../B.../..."
              className="font-mono text-xs"
              type="password"
            />
          </div>
        )}
      </div>

      {/* Icon Emoji */}
      <div className="space-y-1">
        <label className="block text-xs text-[var(--text-secondary)]">
          Icon Emoji <span className="opacity-60">(optional override)</span>
        </label>
        <Input
          value={form.iconEmoji}
          onChange={(e) => setForm((f) => ({ ...f, iconEmoji: e.target.value }))}
          placeholder=":robot_face:"
          className="text-xs w-48"
        />
      </div>

      {/* Enabled */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="pt-form-enabled"
          checked={form.enabled}
          onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
          className="rounded border-[var(--border)] accent-[var(--accent)]"
        />
        <label htmlFor="pt-form-enabled" className="text-xs text-[var(--text-secondary)] cursor-pointer">
          Enabled
        </label>
      </div>

      {/* Test result */}
      {testMutation.data?.success && (
        <div className="text-xs px-3 py-2 rounded-md bg-green-500/10 text-green-400 border border-green-500/20">
          Test message sent successfully!
        </div>
      )}
      {testError && (
        <div className="text-xs px-3 py-2 rounded-md bg-red-500/10 text-red-400 border border-red-500/20">
          Test failed: {testError}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={!canTest || testMutation.isPending}
          className="gap-1.5 text-xs"
        >
          {testMutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}
          Send Test
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onSave(form)} disabled={!isValid || saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

interface TargetRowProps {
  target: PublishTarget
}

function TargetRow({ target }: TargetRowProps) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const updateTarget = useUpdatePublishTarget()
  const deleteTarget = useDeletePublishTarget()

  const handleToggle = () => {
    updateTarget.mutate({ id: target.id, data: { enabled: !target.enabled } })
  }

  const handleSave = (form: FormState) => {
    updateTarget.mutate(
      {
        id: target.id,
        data: {
          name: form.name.trim(),
          config: formToConfig(form),
          enabled: form.enabled,
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
    deleteTarget.mutate(target.id)
  }

  const mode = target.config.webhookUrl ? 'webhook' : 'bot'

  if (editing) {
    return (
      <InlineForm
        initial={formFromTarget(target)}
        onSave={handleSave}
        onCancel={() => setEditing(false)}
        saving={updateTarget.isPending}
      />
    )
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors',
        target.enabled
          ? 'border-[var(--border)] bg-[var(--bg-secondary)]'
          : 'border-[var(--border)] bg-[var(--bg-primary)] opacity-60'
      )}
    >
      {/* Toggle */}
      <button
        onClick={handleToggle}
        disabled={updateTarget.isPending}
        title={target.enabled ? 'Disable' : 'Enable'}
        className={cn(
          'w-4 h-4 rounded-full border-2 flex-shrink-0 transition-colors',
          target.enabled
            ? 'bg-[var(--accent)] border-[var(--accent)]'
            : 'bg-transparent border-[var(--text-secondary)]'
        )}
        aria-label={target.enabled ? 'Disable target' : 'Enable target'}
      />

      {/* Slack icon */}
      <div className="flex-shrink-0 w-6 h-6 rounded bg-[#4A154B] flex items-center justify-center">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="white"/>
        </svg>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)] truncate">
          {target.name}
          {!target.enabled && (
            <span className="ml-2 text-xs text-[var(--text-secondary)] font-normal">(disabled)</span>
          )}
        </p>
        <p className="text-xs text-[var(--text-secondary)] truncate">
          {mode === 'webhook' ? 'Webhook' : `Bot → #${target.config.channel}`}
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
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
              disabled={deleteTarget.isPending}
              className="p-1.5 rounded-md text-red-400 hover:bg-red-400/10 transition-colors"
              title="Confirm delete"
            >
              {deleteTarget.isPending ? (
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

export function PublishTargetManager() {
  const { data: targets = [], isLoading } = usePublishTargets()
  const createTarget = useCreatePublishTarget()

  const [showAddForm, setShowAddForm] = useState(false)

  const handleCreate = (form: FormState) => {
    createTarget.mutate(
      {
        name: form.name.trim(),
        type: 'slack',
        config: formToConfig(form),
        enabled: form.enabled,
      },
      { onSuccess: () => setShowAddForm(false) }
    )
  }

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">Publish Targets</h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            Delivery channels for agent output
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
          <div className="space-y-1">
            <span>
              Publish targets are delivery channels — the agent controls the message content.
              Assign targets to agents in the agent editor.
            </span>
            <p className="text-[var(--text-secondary)] opacity-70">
              Tip: agents can emit a <code className="text-[var(--text-primary)]">&lt;!--CONDUIT:PUBLISH--&gt;</code> block
              in their output to control exactly what gets posted. Otherwise, full output is sent.
            </p>
          </div>
        </div>

        {/* Add form */}
        {showAddForm && (
          <InlineForm
            initial={emptyForm()}
            onSave={handleCreate}
            onCancel={() => setShowAddForm(false)}
            saving={createTarget.isPending}
          />
        )}

        {/* Target list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-sm text-[var(--text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading…
          </div>
        ) : targets.length === 0 && !showAddForm ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
            <div className="w-12 h-12 rounded-xl bg-[#4A154B]/20 flex items-center justify-center mb-2">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="#4A154B" opacity="0.6"/>
              </svg>
            </div>
            <p className="text-sm text-[var(--text-secondary)]">No publish targets configured.</p>
            <p className="text-xs text-[var(--text-secondary)] max-w-xs">
              Add a Slack channel for agents to publish their output to.
            </p>
            <Button size="sm" variant="outline" className="mt-2 gap-1.5" onClick={() => setShowAddForm(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add your first publish target
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {targets.map((target) => (
              <TargetRow key={target.id} target={target} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
