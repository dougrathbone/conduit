import React, { useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Dialog } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { api } from '@renderer/lib/ipc'

interface GistAuthDialogProps {
  open: boolean
  onClose: () => void
  onSaved: () => void
}

export function GistAuthDialog({ open, onClose, onSaved }: GistAuthDialogProps) {
  const [pat, setPat] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!pat.trim()) {
      setError('Please enter your GitHub personal access token.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.prefs.set('githubPat', pat.trim())
      setPat('')
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save token')
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave()
  }

  const openTokenPage = () => {
    api.shell
      .openExternal('https://github.com/settings/tokens/new?scopes=gist&description=Conduit')
      .catch(console.error)
  }

  return (
    <Dialog open={open} onClose={onClose} title="Connect GitHub Gist">
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">
          Conduit uses GitHub Gists to sync your agent prompts. Enter a personal access token
          with the <code className="text-[var(--accent)] font-mono text-xs">gist</code> scope.
        </p>

        <button
          onClick={openTokenPage}
          className="flex items-center gap-1.5 text-xs text-[var(--accent)] hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          Create token at github.com/settings/tokens
        </button>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-[var(--text-secondary)]">
            Personal Access Token
          </label>
          <Input
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ghp_..."
            className="font-mono"
            autoFocus
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !pat.trim()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save Token
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
