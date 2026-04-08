import React, { useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'
import { Cloud, CloudDownload, ExternalLink, FolderOpen, Loader2, Sparkles } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useUIStore } from '@renderer/store/ui'
import { useSaveGist, useLoadGist } from '@renderer/hooks/useGist'
import { api } from '@renderer/lib/ipc'
import { GistAuthDialog } from '@renderer/components/settings/GistAuthDialog'
import { GistBrowserDialog } from '@renderer/components/settings/GistBrowserDialog'
import { PromptChatPanel } from './PromptChatPanel'
import type { RunnerType } from '@shared/types'

interface PromptEditorProps {
  value: string
  onChange: (value: string) => void
  gistId?: string
  onGistIdChange: (gistId: string | undefined) => void
  agentId?: string
  runner?: RunnerType
}

export function PromptEditor({
  value,
  onChange,
  gistId,
  onGistIdChange,
  agentId,
  runner,
}: PromptEditorProps) {
  const { theme } = useUIStore()
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const [showGistAuth, setShowGistAuth] = useState(false)
  const [showGistBrowser, setShowGistBrowser] = useState(false)
  const [gistError, setGistError] = useState<string | null>(null)
  const [isChatOpen, setIsChatOpen] = useState(false)

  const saveGist = useSaveGist()
  const loadGist = useLoadGist()

  const handleBrowseGists = async () => {
    const pat = await api.prefs.get<string>('githubPat')
    if (!pat) {
      setShowGistAuth(true)
      return
    }
    setShowGistBrowser(true)
  }

  const handleGistSelected = (content: string, newGistId: string) => {
    onChange(content)
    onGistIdChange(newGistId)
  }

  const handleSaveToGist = async () => {
    setGistError(null)
    try {
      const pat = await api.prefs.get<string>('githubPat')
      if (!pat) {
        setShowGistAuth(true)
        return
      }
      const newGistId = await saveGist.mutateAsync({ content: value, gistId })
      onGistIdChange(newGistId)
    } catch (e) {
      setGistError(e instanceof Error ? e.message : 'Failed to save gist')
    }
  }

  const handleLoadFromGist = async () => {
    if (!gistId) return
    setGistError(null)
    try {
      const content = await loadGist.mutateAsync(gistId)
      onChange(content)
    } catch (e) {
      setGistError(e instanceof Error ? e.message : 'Failed to load gist')
    }
  }

  const handleOpenGist = () => {
    if (gistId) {
      api.shell.openExternal(`https://gist.github.com/${gistId}`).catch(console.error)
    }
  }

  const handleApplyPrompt = (prompt: string) => {
    onChange(prompt)
    setIsChatOpen(false)
  }

  const isSaving = saveGist.isPending
  const isLoading = loadGist.isPending

  return (
    <div className="space-y-1.5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSaveToGist}
            disabled={isSaving}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] gap-1.5 text-xs"
            title="Save prompt to GitHub Gist"
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Cloud className="h-3.5 w-3.5" />
            )}
            {gistId ? 'Update Gist' : 'Save to Gist'}
          </Button>

          {gistId && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLoadFromGist}
                disabled={isLoading}
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] gap-1.5 text-xs"
                title="Load latest from Gist"
              >
                {isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CloudDownload className="h-3.5 w-3.5" />
                )}
                Load from Gist
              </Button>
              <button
                onClick={handleOpenGist}
                className="flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
                title="Open Gist in browser"
              >
                <ExternalLink className="h-3 w-3" />
                View Gist
              </button>
            </>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={handleBrowseGists}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] gap-1.5 text-xs"
            title="Browse and load a prompt from GitHub Gists"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Browse Gists
          </Button>

          {agentId && runner && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsChatOpen((v) => !v)}
              className={`gap-1.5 text-xs transition-colors ${
                isChatOpen
                  ? 'text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/15'
                  : 'text-[var(--text-secondary)] hover:text-[var(--accent)]'
              }`}
              title="Craft prompt collaboratively with Claude AI"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Craft with AI
            </Button>
          )}
        </div>

        {gistError && (
          <p className="text-xs text-red-400">{gistError}</p>
        )}
      </div>

      <div className="rounded-md border border-[var(--border)] overflow-hidden">
        <CodeMirror
          value={value}
          height="300px"
          extensions={[
            EditorView.lineWrapping,
          ]}
          theme={isDark ? oneDark : undefined}
          onChange={onChange}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            autocompletion: false,
          }}
        />
      </div>

      {isChatOpen && agentId && runner && (
        <div className="mt-3" style={{ height: '520px' }}>
          <PromptChatPanel
            agentId={agentId}
            runner={runner}
            onApplyPrompt={handleApplyPrompt}
            onClose={() => setIsChatOpen(false)}
          />
        </div>
      )}

      <GistAuthDialog
        open={showGistAuth}
        onClose={() => setShowGistAuth(false)}
        onSaved={() => {
          setShowGistAuth(false)
          handleSaveToGist()
        }}
      />

      <GistBrowserDialog
        open={showGistBrowser}
        onClose={() => setShowGistBrowser(false)}
        onSelect={handleGistSelected}
      />
    </div>
  )
}
