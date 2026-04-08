import React, { useState } from 'react'
import { Plus, Trash2, Clock, Globe, Loader2, Check, X, Copy } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  useTriggers,
  useCreateTrigger,
  useUpdateTrigger,
  useDeleteTrigger,
} from '@renderer/hooks/useTriggers'
import { cn } from '@renderer/lib/utils'
import type {
  TriggerType,
  TriggerConfig,
  CronTriggerConfig,
  SlackTriggerConfig,
  WebhookTriggerConfig,
  Trigger,
} from '@shared/types'

// ── Slack icon ───────────────────────────────────────────────────────────────

function SlackIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
    </svg>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function typeIcon(type: TriggerType) {
  switch (type) {
    case 'cron': return <Clock className="h-3.5 w-3.5" />
    case 'slack': return <SlackIcon size={14} />
    case 'webhook': return <Globe className="h-3.5 w-3.5" />
  }
}

function triggerSubtitle(trigger: Trigger): string {
  switch (trigger.type) {
    case 'cron': return (trigger.config as CronTriggerConfig).expression
    case 'slack': {
      const f = (trigger.config as SlackTriggerConfig).channelFilter
      return f ? `Channel: ${f}` : 'All channels'
    }
    case 'webhook': return `POST /api/triggers/webhook/${trigger.id}`
  }
}

function getWebhookUrl(triggerId: string): string {
  const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:7456'
  return `${base}/api/triggers/webhook/${triggerId}`
}

// ── Form ─────────────────────────────────────────────────────────────────────

interface FormState {
  name: string
  type: TriggerType
  cronExpression: string
  cronTimezone: string
  slackChannelFilter: string
  webhookSecret: string
}

function emptyForm(): FormState {
  return { name: '', type: 'cron', cronExpression: '0 9 * * 1-5', cronTimezone: '', slackChannelFilter: '', webhookSecret: '' }
}

function formFromTrigger(t: Trigger): FormState {
  const base = emptyForm()
  base.name = t.name
  base.type = t.type
  if (t.type === 'cron') {
    const c = t.config as CronTriggerConfig
    base.cronExpression = c.expression
    base.cronTimezone = c.timezone ?? ''
  } else if (t.type === 'slack') {
    base.slackChannelFilter = (t.config as SlackTriggerConfig).channelFilter ?? ''
  } else if (t.type === 'webhook') {
    base.webhookSecret = (t.config as WebhookTriggerConfig).secret ?? ''
  }
  return base
}

function formToConfig(form: FormState): TriggerConfig {
  switch (form.type) {
    case 'cron': return { expression: form.cronExpression.trim(), timezone: form.cronTimezone.trim() || undefined } as CronTriggerConfig
    case 'slack': return { channelFilter: form.slackChannelFilter.trim() || undefined } as SlackTriggerConfig
    case 'webhook': return { secret: form.webhookSecret.trim() || undefined } as WebhookTriggerConfig
  }
}

function isFormValid(form: FormState): boolean {
  if (!form.name.trim()) return false
  if (form.type === 'cron' && !form.cronExpression.trim()) return false
  return true
}

interface InlineFormProps {
  initial: FormState
  onSave: (form: FormState) => void
  onCancel: () => void
  saving: boolean
  existingId?: string
}

function InlineForm({ initial, onSave, onCancel, saving, existingId }: InlineFormProps) {
  const [form, setForm] = useState<FormState>(initial)
  const [copied, setCopied] = useState(false)

  const handleCopyUrl = () => {
    if (existingId) {
      navigator.clipboard.writeText(getWebhookUrl(existingId))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--bg-secondary)] p-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">Name</label>
          <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Daily patrol" autoFocus />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">Type</label>
          <div className="flex gap-1 p-0.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border)]">
            {(['cron', 'slack', 'webhook'] as TriggerType[]).map(t => (
              <button key={t} type="button" onClick={() => setForm(f => ({ ...f, type: t }))}
                className={cn('flex-1 flex items-center justify-center gap-1 text-xs py-1 rounded-md transition-colors font-medium capitalize',
                  form.type === t ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
                {typeIcon(t)} {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {form.type === 'cron' && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="block text-xs text-[var(--text-secondary)]">Cron Expression</label>
            <Input value={form.cronExpression} onChange={e => setForm(f => ({ ...f, cronExpression: e.target.value }))} placeholder="0 9 * * 1-5" className="font-mono text-xs" />
            <p className="text-[10px] text-[var(--text-secondary)] opacity-70">min hour day month weekday</p>
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-[var(--text-secondary)]">Timezone <span className="opacity-60">(optional)</span></label>
            <Input value={form.cronTimezone} onChange={e => setForm(f => ({ ...f, cronTimezone: e.target.value }))} placeholder="America/New_York" className="text-xs" />
          </div>
        </div>
      )}

      {form.type === 'slack' && (
        <div className="space-y-1">
          <label className="block text-xs text-[var(--text-secondary)]">Channel Filter <span className="opacity-60">(optional — leave empty for all channels)</span></label>
          <Input value={form.slackChannelFilter} onChange={e => setForm(f => ({ ...f, slackChannelFilter: e.target.value }))} placeholder="C0123456789" className="font-mono text-xs" />
          <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
            Slack Event URL: <code className="text-[var(--text-primary)]">{window.location.origin}/api/triggers/slack</code>
          </p>
        </div>
      )}

      {form.type === 'webhook' && (
        <div className="space-y-2">
          <div className="space-y-1">
            <label className="block text-xs text-[var(--text-secondary)]">Signing Secret <span className="opacity-60">(optional)</span></label>
            <Input value={form.webhookSecret} onChange={e => setForm(f => ({ ...f, webhookSecret: e.target.value }))} placeholder="whsec_..." className="font-mono text-xs" type="password" />
          </div>
          {existingId && (
            <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border)]">
              <code className="flex-1 text-xs text-[var(--text-primary)] font-mono truncate">{getWebhookUrl(existingId)}</code>
              <button onClick={handleCopyUrl} className="flex-shrink-0 text-xs text-[var(--accent)] hover:underline flex items-center gap-1">
                <Copy className="h-3 w-3" /> {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button size="sm" onClick={() => onSave(form)} disabled={!isFormValid(form) || saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save
        </Button>
      </div>
    </div>
  )
}

// ── Trigger Row ──────────────────────────────────────────────────────────────

function TriggerRow({ trigger, agentId }: { trigger: Trigger; agentId: string }) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const updateTrigger = useUpdateTrigger()
  const deleteTrigger = useDeleteTrigger(agentId)

  const handleToggle = () => updateTrigger.mutate({ id: trigger.id, data: { enabled: !trigger.enabled } })

  const handleSave = (form: FormState) => {
    updateTrigger.mutate(
      { id: trigger.id, data: { name: form.name.trim(), type: form.type, config: formToConfig(form), enabled: trigger.enabled } },
      { onSuccess: () => setEditing(false) }
    )
  }

  const handleDelete = () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    deleteTrigger.mutate(trigger.id)
  }

  if (editing) {
    return <InlineForm initial={formFromTrigger(trigger)} onSave={handleSave} onCancel={() => setEditing(false)} saving={updateTrigger.isPending} existingId={trigger.id} />
  }

  return (
    <div className={cn('flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-colors',
      trigger.enabled ? 'border-[var(--border)] bg-[var(--bg-secondary)]' : 'border-[var(--border)] bg-[var(--bg-primary)] opacity-60')}>
      <button onClick={handleToggle} disabled={updateTrigger.isPending}
        className={cn('w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 transition-colors',
          trigger.enabled ? 'bg-[var(--accent)] border-[var(--accent)]' : 'bg-transparent border-[var(--text-secondary)]')} />
      <span className="flex-shrink-0 text-[var(--text-secondary)]">{typeIcon(trigger.type)}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-[var(--text-primary)] truncate">{trigger.name}</p>
        <p className="text-[10px] text-[var(--text-secondary)] font-mono truncate">{triggerSubtitle(trigger)}</p>
      </div>
      {trigger.lastTriggeredAt && (
        <span className="text-[10px] text-[var(--text-secondary)] flex-shrink-0">
          Last: {new Date(trigger.lastTriggeredAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <button onClick={() => { setEditing(true); setConfirmDelete(false) }} className="p-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" title="Edit">
          <Clock className="h-3 w-3" />
        </button>
        {confirmDelete ? (
          <>
            <button onClick={handleDelete} disabled={deleteTrigger.isPending} className="p-1 rounded text-red-400 hover:bg-red-400/10" title="Confirm">
              {deleteTrigger.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            </button>
            <button onClick={() => setConfirmDelete(false)} className="p-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title="Cancel">
              <X className="h-3 w-3" />
            </button>
          </>
        ) : (
          <button onClick={handleDelete} className="p-1 rounded text-[var(--text-secondary)] hover:text-red-400 transition-colors" title="Delete">
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

interface TriggerEditorProps {
  agentId: string
}

export function TriggerEditor({ agentId }: TriggerEditorProps) {
  const { data: triggers = [] } = useTriggers(agentId)
  const createTrigger = useCreateTrigger()
  const [showAddForm, setShowAddForm] = useState(false)

  const handleCreate = (form: FormState) => {
    createTrigger.mutate(
      { agentId, name: form.name.trim(), type: form.type, config: formToConfig(form), enabled: true },
      { onSuccess: () => setShowAddForm(false) }
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">Triggers</label>
        <Button variant="ghost" size="sm" onClick={() => setShowAddForm(true)} disabled={showAddForm} className="gap-1 text-xs h-6 px-2">
          <Plus className="h-3 w-3" /> Add
        </Button>
      </div>

      {showAddForm && (
        <InlineForm initial={emptyForm()} onSave={handleCreate} onCancel={() => setShowAddForm(false)} saving={createTrigger.isPending} />
      )}

      {triggers.length > 0 && (
        <div className="space-y-1.5">
          {triggers.map(t => <TriggerRow key={t.id} trigger={t} agentId={agentId} />)}
        </div>
      )}

      {triggers.length === 0 && !showAddForm && (
        <p className="text-xs text-[var(--text-secondary)] opacity-60">No triggers — this agent runs on demand only.</p>
      )}
    </div>
  )
}
