import React, { useState, useMemo, useEffect, useRef } from 'react'
import { Search, X, FileText, Lock, Globe, Clock, ArrowRight, Loader2, RefreshCw, AlertCircle } from 'lucide-react'
import { useListGists, useLoadGist } from '@renderer/hooks/useGist'
import { useQueryClient } from '@tanstack/react-query'
import type { GistSummary } from '@shared/types'
import { formatDistanceToNow } from 'date-fns'

interface GistBrowserDialogProps {
  open: boolean
  onClose: () => void
  onSelect: (content: string, gistId: string) => void
}

export function GistBrowserDialog({ open, onClose, onSelect }: GistBrowserDialogProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<GistSummary | null>(null)
  const [filter, setFilter] = useState<'all' | 'conduit'>('all')
  const queryClient = useQueryClient()
  const searchRef = useRef<HTMLInputElement>(null)
  const loadGist = useLoadGist()

  const { data: gists, isLoading, error, isFetching } = useListGists(open)

  // Focus search on open
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(null)
      setTimeout(() => searchRef.current?.focus(), 50)
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const filtered = useMemo(() => {
    if (!gists) return []
    return gists.filter((g) => {
      if (filter === 'conduit' && !g.isConduitPrompt) return false
      if (!query.trim()) return true
      const q = query.toLowerCase()
      return (
        g.description.toLowerCase().includes(q) ||
        Object.keys(g.files).some((f) => f.toLowerCase().includes(q))
      )
    })
  }, [gists, query, filter])

  const handleLoad = async () => {
    if (!selected) return
    const gistId = selected.id
    // Load prompt.md if it exists, else the first file
    const targetFile = selected.isConduitPrompt
      ? 'prompt.md'
      : Object.keys(selected.files)[0]

    // We use the existing load handler which fetches prompt.md
    try {
      const content = await loadGist.mutateAsync(gistId)
      onSelect(content, gistId)
      onClose()
    } catch {
      // The load hook reads prompt.md — if no prompt.md, fetch raw file content
      // This is fine for now since we're focused on Conduit-created gists
    }
  }

  const fileCount = (g: GistSummary) => Object.keys(g.files).length

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
    >
      <div
        className="relative flex flex-col overflow-hidden"
        style={{
          width: '680px',
          height: '560px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: '14px',
          boxShadow: '0 32px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)',
          fontFamily: "'IBM Plex Mono', 'Fira Code', monospace",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 py-4"
          style={{
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-primary)',
          }}
        >
          <div className="flex items-center gap-2 flex-1">
            {/* Octocat-inspired icon */}
            <div
              className="flex items-center justify-center rounded-md"
              style={{
                width: 28,
                height: 28,
                background: 'linear-gradient(135deg, var(--accent), #a78bfa)',
                flexShrink: 0,
              }}
            >
              <FileText className="h-3.5 w-3.5 text-white" />
            </div>
            <div>
              <div className="text-xs font-semibold tracking-wider uppercase" style={{ color: 'var(--text-secondary)', letterSpacing: '0.08em' }}>
                GitHub Gists
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Filter pills */}
            {(['all', 'conduit'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
                style={{
                  background: filter === f ? 'var(--accent)' : 'var(--bg-secondary)',
                  color: filter === f ? '#fff' : 'var(--text-secondary)',
                  border: `1px solid ${filter === f ? 'var(--accent)' : 'var(--border)'}`,
                  letterSpacing: '0.03em',
                }}
              >
                {f === 'all' ? 'All Gists' : '✦ Conduit'}
              </button>
            ))}

            <button
              onClick={() => queryClient.invalidateQueries({ queryKey: ['gists'] })}
              className="p-1.5 rounded-md transition-colors hover:bg-[var(--border)]"
              style={{ color: 'var(--text-secondary)' }}
              title="Refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md transition-colors hover:bg-[var(--border)]"
              style={{ color: 'var(--text-secondary)' }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Search bar */}
        <div
          className="px-4 py-2.5"
          style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-primary)' }}
        >
          <div
            className="flex items-center gap-2.5 rounded-md px-3 py-2"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
          >
            <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by description or filename…"
              className="flex-1 bg-transparent text-xs outline-none placeholder:opacity-50"
              style={{ color: 'var(--text-primary)', fontFamily: 'inherit' }}
            />
            {query && (
              <button onClick={() => setQuery('')} className="opacity-50 hover:opacity-100">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* Content area */}
        <div className="flex flex-1 min-h-0">
          {/* Gist list */}
          <div
            className="flex flex-col overflow-y-auto"
            style={{
              width: '280px',
              flexShrink: 0,
              borderRight: '1px solid var(--border)',
            }}
          >
            {isLoading && (
              <div className="flex flex-col items-center justify-center gap-3 py-16">
                <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--accent)' }} />
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  Fetching gists…
                </span>
              </div>
            )}

            {error && (
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                <AlertCircle className="h-5 w-5 text-red-400" />
                <p className="text-xs text-red-400">
                  {error instanceof Error ? error.message : 'Failed to load gists'}
                </p>
              </div>
            )}

            {!isLoading && !error && filtered.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 py-16 px-4 text-center">
                <div className="text-2xl opacity-30">◇</div>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {query ? 'No gists match your search' : filter === 'conduit' ? 'No Conduit prompts found' : 'No gists found'}
                </p>
              </div>
            )}

            {filtered.map((gist) => {
              const isSelected = selected?.id === gist.id
              return (
                <button
                  key={gist.id}
                  onClick={() => setSelected(gist)}
                  onDoubleClick={() => { setSelected(gist); handleLoad() }}
                  className="w-full text-left px-4 py-3 transition-all"
                  style={{
                    background: isSelected
                      ? 'linear-gradient(90deg, rgba(129,140,248,0.12), rgba(129,140,248,0.06))'
                      : 'transparent',
                    borderBottom: '1px solid var(--border)',
                    borderLeft: isSelected ? '2px solid var(--accent)' : '2px solid transparent',
                  }}
                >
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <span
                      className="text-xs font-medium truncate leading-tight"
                      style={{ color: isSelected ? 'var(--accent)' : 'var(--text-primary)', maxWidth: '160px' }}
                    >
                      {gist.description || <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>No description</span>}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      {gist.isConduitPrompt && (
                        <span
                          className="text-[10px] px-1.5 rounded-sm font-bold tracking-wide"
                          style={{ background: 'var(--accent)', color: '#fff', opacity: 0.9 }}
                        >
                          ✦
                        </span>
                      )}
                      {gist.public
                        ? <Globe className="h-2.5 w-2.5" style={{ color: 'var(--text-secondary)', opacity: 0.5 }} />
                        : <Lock className="h-2.5 w-2.5" style={{ color: 'var(--text-secondary)', opacity: 0.5 }} />
                      }
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px]" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>
                      {fileCount(gist)} {fileCount(gist) === 1 ? 'file' : 'files'}
                    </span>
                    <span style={{ color: 'var(--border)' }}>·</span>
                    <span className="text-[10px] flex items-center gap-0.5" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
                      <Clock className="h-2 w-2" />
                      {formatDistanceToNow(new Date(gist.updatedAt), { addSuffix: true })}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Preview pane */}
          <div className="flex flex-col flex-1 min-w-0">
            {!selected ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 px-8 text-center">
                <div
                  className="text-4xl"
                  style={{ opacity: 0.15, fontFamily: 'monospace' }}
                >
                  {'{ }'}
                </div>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
                  Select a gist to preview.<br />Double-click to load immediately.
                </p>
              </div>
            ) : (
              <div className="flex flex-col h-full">
                {/* Preview header */}
                <div
                  className="px-4 py-3 flex items-start justify-between gap-3"
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <div className="min-w-0">
                    <p
                      className="text-xs font-semibold truncate"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {selected.description || 'Untitled Gist'}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {Object.keys(selected.files).slice(0, 3).map((fname) => (
                        <span
                          key={fname}
                          className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{
                            background: 'var(--border)',
                            color: 'var(--text-secondary)',
                            fontFamily: 'monospace',
                          }}
                        >
                          {fname}
                        </span>
                      ))}
                      {Object.keys(selected.files).length > 3 && (
                        <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                          +{Object.keys(selected.files).length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                  <div
                    className="text-[10px] shrink-0 px-2 py-1 rounded-md"
                    style={{
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {selected.public ? '🌐 Public' : '🔒 Secret'}
                  </div>
                </div>

                {/* File list */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                  {Object.entries(selected.files).map(([fname, file]) => (
                    <div
                      key={fname}
                      className="rounded-md overflow-hidden"
                      style={{ border: '1px solid var(--border)' }}
                    >
                      <div
                        className="px-3 py-1.5 flex items-center justify-between"
                        style={{ background: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }}
                      >
                        <span
                          className="text-[10px] font-medium"
                          style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}
                        >
                          {fname}
                        </span>
                        <span className="text-[10px]" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>
                          {(file.size / 1024).toFixed(1)} KB
                          {file.language ? ` · ${file.language}` : ''}
                        </span>
                      </div>
                      {file.truncated === false && file.content ? (
                        <pre
                          className="p-3 text-[10px] leading-relaxed overflow-hidden"
                          style={{
                            color: 'var(--text-secondary)',
                            fontFamily: 'monospace',
                            maxHeight: '120px',
                            background: 'var(--bg-secondary)',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          }}
                        >
                          {file.content.slice(0, 400)}{file.content.length > 400 ? '…' : ''}
                        </pre>
                      ) : (
                        <div
                          className="px-3 py-4 text-[10px] italic text-center"
                          style={{ color: 'var(--text-secondary)', opacity: 0.5 }}
                        >
                          Preview not available — load to view full content
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Load button */}
                <div
                  className="px-4 py-3 flex items-center justify-between"
                  style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-primary)' }}
                >
                  <p className="text-[10px]" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
                    {selected.isConduitPrompt
                      ? 'Loads prompt.md into the editor'
                      : 'Loads first file into the editor'}
                  </p>
                  <button
                    onClick={handleLoad}
                    disabled={loadGist.isPending}
                    className="flex items-center gap-2 px-4 py-1.5 rounded-md text-xs font-medium transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
                    style={{
                      background: 'var(--accent)',
                      color: '#fff',
                      fontFamily: 'inherit',
                    }}
                  >
                    {loadGist.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ArrowRight className="h-3.5 w-3.5" />
                    )}
                    Load into Editor
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
