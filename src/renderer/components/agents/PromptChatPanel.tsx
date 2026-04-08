import React, { useState, useEffect, useRef, useCallback, KeyboardEvent } from 'react'
import { X, Send, Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { usePromptChat } from '@renderer/hooks/usePromptChat'
import type { ChatMessage, RunnerType } from '@shared/types'

interface PromptChatPanelProps {
  agentId: string
  runner: RunnerType
  onApplyPrompt: (prompt: string) => void
  onClose: () => void
}

// ─── Markdown-like renderer for assistant messages ────────────────────────────

function renderContent(content: string, isStreaming: boolean): React.ReactNode {
  if (content === '__streaming__') {
    return <span className="animate-pulse text-[var(--text-secondary)]">▋</span>
  }

  // Split on code blocks
  const parts = content.split(/(```[\s\S]*?```)/g)

  return (
    <>
      {parts.map((part, i) => {
        const promptMatch = part.match(/^```prompt\n([\s\S]*?)\n```$/)
        const codeMatch = part.match(/^```(\w*)\n([\s\S]*?)\n```$/)

        if (promptMatch) {
          return (
            <div
              key={i}
              className="my-2 rounded-lg bg-green-500/10 border border-green-500/30 p-3"
            >
              <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-green-500">
                <Sparkles className="h-3 w-3" />
                Proposed Prompt
              </div>
              <pre className="text-xs font-mono text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">
                {promptMatch[1]}
              </pre>
            </div>
          )
        }

        if (codeMatch) {
          return (
            <div key={i} className="my-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border)] overflow-hidden">
              {codeMatch[1] && (
                <div className="px-3 py-1 text-xs text-[var(--text-secondary)] border-b border-[var(--border)] bg-[var(--bg-secondary)]">
                  {codeMatch[1]}
                </div>
              )}
              <pre className="p-3 text-xs font-mono text-[var(--text-primary)] whitespace-pre-wrap overflow-x-auto">
                {codeMatch[2]}
              </pre>
            </div>
          )
        }

        // Plain text — render inline code and newlines
        return (
          <span key={i} className="whitespace-pre-wrap leading-relaxed">
            {part.split(/(`[^`]+`)/g).map((seg, j) => {
              if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
                return (
                  <code
                    key={j}
                    className="px-1 py-0.5 rounded text-xs font-mono bg-[var(--bg-primary)] border border-[var(--border)]"
                  >
                    {seg.slice(1, -1)}
                  </code>
                )
              }
              return seg
            })}
          </span>
        )
      })}
      {isStreaming && <span className="animate-pulse ml-0.5">▋</span>}
    </>
  )
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({
  message,
  isStreaming,
}: {
  message: ChatMessage
  isStreaming: boolean
}) {
  const isUser = message.role === 'user'

  if (isUser) {
    return (
      <div className="flex justify-end gap-2 group">
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm px-3.5 py-2.5 bg-[var(--accent)] text-white text-sm">
          <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
        </div>
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--border)] flex items-center justify-center text-xs font-medium text-[var(--text-secondary)] mt-0.5">
          U
        </div>
      </div>
    )
  }

  const isCurrentlyStreaming = isStreaming && message.content === '__streaming__'

  return (
    <div className="flex justify-start gap-2 group">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--accent)]/10 border border-[var(--accent)]/20 flex items-center justify-center text-xs mt-0.5">
        <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
      </div>
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm px-3.5 py-2.5 bg-[var(--bg-primary)] border border-[var(--border)] text-sm text-[var(--text-primary)]">
        {message.content === '__streaming__' && !isCurrentlyStreaming ? (
          <span className="text-[var(--text-secondary)] italic text-xs">Thinking...</span>
        ) : (
          renderContent(message.content, isCurrentlyStreaming)
        )}
      </div>
    </div>
  )
}

// ─── Extracted prompt banner ──────────────────────────────────────────────────

function ExtractedPromptBanner({
  prompt,
  onApply,
  onDismiss,
}: {
  prompt: string
  onApply: () => void
  onDismiss: () => void
}) {
  return (
    <div className="border-t border-[var(--border)] bg-green-500/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-green-500">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Extracted Prompt — ready to apply
        </div>
        <button
          onClick={onDismiss}
          className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="rounded-lg bg-[var(--bg-primary)] border border-green-500/20 p-2.5 max-h-28 overflow-y-auto">
        <pre className="text-xs font-mono text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">
          {prompt}
        </pre>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={onApply}
          className="flex-1 bg-green-600 hover:bg-green-700 text-white border-0 text-xs"
        >
          <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
          Apply Prompt
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          className="text-xs text-[var(--text-secondary)]"
        >
          Dismiss
        </Button>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function PromptChatPanel({ agentId, runner, onApplyPrompt, onClose }: PromptChatPanelProps) {
  const {
    messages,
    isStreaming,
    extractedPrompt,
    error,
    startSession,
    sendMessage,
    closeSession,
    clearExtractedPrompt,
  } = usePromptChat(agentId, runner)

  const [inputValue, setInputValue] = useState('')
  const [isStarting, setIsStarting] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Start the session on mount
  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        await startSession()
      } finally {
        if (!cancelled) setIsStarting(false)
      }
    }

    init()

    return () => {
      cancelled = true
      closeSession()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-scroll to bottom whenever messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = useCallback(async () => {
    const text = inputValue.trim()
    if (!text || isStreaming) return
    setInputValue('')
    await sendMessage(text)
    textareaRef.current?.focus()
  }, [inputValue, isStreaming, sendMessage])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const handleApplyPrompt = useCallback(() => {
    if (extractedPrompt) {
      onApplyPrompt(extractedPrompt)
      clearExtractedPrompt()
      onClose()
    }
  }, [extractedPrompt, onApplyPrompt, clearExtractedPrompt, onClose])

  return (
    <div className="flex flex-col h-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-primary)]">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-[var(--accent)]/10 flex items-center justify-center">
            <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Craft Prompt with AI</h3>
            <p className="text-xs text-[var(--text-secondary)]">Ask Claude to help you build the perfect prompt</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
          aria-label="Close chat"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
        {isStarting && (
          <div className="flex justify-start gap-2">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--accent)]/10 border border-[var(--accent)]/20 flex items-center justify-center text-xs">
              <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
            </div>
            <div className="rounded-2xl rounded-tl-sm px-3.5 py-2.5 bg-[var(--bg-primary)] border border-[var(--border)]">
              <div className="flex items-center gap-1.5">
                <span className="animate-pulse text-[var(--text-secondary)] text-sm">▋</span>
                <span className="text-xs text-[var(--text-secondary)]">Starting session...</span>
              </div>
            </div>
          </div>
        )}

        {messages.length === 0 && !isStarting && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="w-10 h-10 rounded-full bg-[var(--accent)]/10 flex items-center justify-center mb-3">
              <Sparkles className="h-5 w-5 text-[var(--accent)]" />
            </div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-1">
              Ready to craft your prompt
            </p>
            <p className="text-xs text-[var(--text-secondary)] max-w-xs">
              Describe what you want your agent to do and Claude will help you build the perfect prompt.
            </p>
          </div>
        )}

        {messages.map((msg, idx) => {
          const isLast = idx === messages.length - 1
          return (
            <MessageBubble
              key={idx}
              message={msg}
              isStreaming={isStreaming && isLast}
            />
          )
        })}

        {/* Error state */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium mb-0.5">Error</p>
              <p className="text-xs leading-relaxed">{error}</p>
              {error.includes('ANTHROPIC_API_KEY') && (
                <p className="text-xs mt-1 text-red-300">
                  Set <code className="font-mono bg-red-500/10 px-1 rounded">ANTHROPIC_API_KEY</code> in your agent's Environment Variables or your system environment.
                </p>
              )}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Extracted Prompt Banner */}
      {extractedPrompt && (
        <ExtractedPromptBanner
          prompt={extractedPrompt}
          onApply={handleApplyPrompt}
          onDismiss={clearExtractedPrompt}
        />
      )}

      {/* Input area */}
      <div className="border-t border-[var(--border)] p-3 bg-[var(--bg-primary)]">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
            disabled={isStreaming || isStarting}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] focus:border-[var(--accent)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors leading-relaxed"
            style={{ maxHeight: '120px', overflowY: 'auto' }}
            onInput={(e) => {
              const el = e.currentTarget
              el.style.height = 'auto'
              el.style.height = Math.min(el.scrollHeight, 120) + 'px'
            }}
          />
          <Button
            size="sm"
            onClick={handleSend}
            disabled={!inputValue.trim() || isStreaming || isStarting}
            className="flex-shrink-0 h-9 w-9 p-0 bg-[var(--accent)] hover:bg-[var(--accent)]/90 border-0 text-white"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-1.5 text-center">
          Powered by Claude · <kbd className="font-mono">Enter</kbd> send · <kbd className="font-mono">Shift+Enter</kbd> newline
        </p>
      </div>
    </div>
  )
}
