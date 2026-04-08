import React, { useState } from 'react'
import { Plus, X, Eye, EyeOff } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'

interface EnvVarEditorProps {
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
}

interface EnvEntry {
  key: string
  value: string
  id: number
}

function recordToEntries(record: Record<string, string>): EnvEntry[] {
  return Object.entries(record).map(([key, value], idx) => ({ key, value, id: idx }))
}

function entriesToRecord(entries: EnvEntry[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of entries) {
    if (entry.key.trim()) {
      result[entry.key.trim()] = entry.value
    }
  }
  return result
}

export function EnvVarEditor({ value, onChange }: EnvVarEditorProps) {
  const [entries, setEntries] = useState<EnvEntry[]>(() => recordToEntries(value))
  const [nextId, setNextId] = useState(() => Object.keys(value).length)
  const [hiddenValues, setHiddenValues] = useState<Set<number>>(new Set())

  const updateEntries = (newEntries: EnvEntry[]) => {
    setEntries(newEntries)
    onChange(entriesToRecord(newEntries))
  }

  const addEntry = () => {
    const newEntry: EnvEntry = { key: '', value: '', id: nextId }
    setNextId((n) => n + 1)
    updateEntries([...entries, newEntry])
  }

  const removeEntry = (id: number) => {
    updateEntries(entries.filter((e) => e.id !== id))
    setHiddenValues((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const updateKey = (id: number, key: string) => {
    updateEntries(entries.map((e) => (e.id === id ? { ...e, key } : e)))
  }

  const updateValue = (id: number, val: string) => {
    updateEntries(entries.map((e) => (e.id === id ? { ...e, value: val } : e)))
  }

  const toggleHide = (id: number) => {
    setHiddenValues((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const isSecret = (key: string) =>
    /api[_-]?key|token|secret|password|pat|auth/i.test(key)

  return (
    <div className="space-y-1.5">
      {entries.length > 0 && (
        <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-1.5 mb-1">
          <span className="text-xs text-[var(--text-secondary)] px-1">Key</span>
          <span className="text-xs text-[var(--text-secondary)] px-1">Value</span>
          <span />
          <span />
        </div>
      )}
      {entries.map((entry) => {
        const hidden = hiddenValues.has(entry.id) || isSecret(entry.key)
        return (
          <div key={entry.id} className="grid grid-cols-[1fr_1fr_auto_auto] gap-1.5 items-center">
            <Input
              value={entry.key}
              onChange={(e) => updateKey(entry.id, e.target.value)}
              placeholder="KEY"
              className="font-mono text-xs uppercase"
            />
            <Input
              value={entry.value}
              onChange={(e) => updateValue(entry.id, e.target.value)}
              placeholder="value"
              type={hidden ? 'password' : 'text'}
              className="font-mono text-xs"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggleHide(entry.id)}
              className="px-1.5 text-[var(--text-secondary)]"
              title={hidden ? 'Show value' : 'Hide value'}
            >
              {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => removeEntry(entry.id)}
              className="px-1.5 text-[var(--text-secondary)] hover:text-red-400"
              title="Remove variable"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )
      })}
      <Button
        variant="ghost"
        size="sm"
        onClick={addEntry}
        className="mt-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] gap-1.5"
      >
        <Plus className="h-3.5 w-3.5" />
        Add Variable
      </Button>
    </div>
  )
}
