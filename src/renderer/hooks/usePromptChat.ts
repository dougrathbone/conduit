import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/ipc'
import type { ChatMessage, RunnerType } from '@shared/types'

export interface UsePromptChatReturn {
  messages: ChatMessage[]
  sessionId: string | null
  isStreaming: boolean
  extractedPrompt: string | null
  error: string | null
  startSession: () => Promise<void>
  sendMessage: (text: string) => Promise<void>
  closeSession: () => void
  clearExtractedPrompt: () => void
}

export function usePromptChat(agentId: string, runner: RunnerType): UsePromptChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [extractedPrompt, setExtractedPrompt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const streamingContentRef = useRef('')
  // Keep a ref to the current sessionId so listeners always have the latest value
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    const unsubToken = api.onPromptChatToken(({ sessionId: sid, token }) => {
      if (sid !== sessionIdRef.current) return
      streamingContentRef.current += token
      const currentContent = streamingContentRef.current
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last?.role === 'assistant' && last.content === '__streaming__') {
          return [
            ...prev.slice(0, -1),
            { ...last, content: currentContent },
          ]
        }
        return prev
      })
    })

    const unsubDone = api.onPromptChatDone(({ sessionId: sid, extractedPrompt: ep }) => {
      if (sid !== sessionIdRef.current) return
      setIsStreaming(false)
      if (ep) setExtractedPrompt(ep)
      streamingContentRef.current = ''
    })

    const unsubError = api.onPromptChatError(({ sessionId: sid, error: err }) => {
      if (sid !== sessionIdRef.current) return
      setIsStreaming(false)
      setError(err)
      streamingContentRef.current = ''
    })

    return () => {
      unsubToken()
      unsubDone()
      unsubError()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startSession = useCallback(async () => {
    const sid = await api.promptChat.start(agentId, runner)
    setSessionId(sid)
    sessionIdRef.current = sid
    setMessages([])
    setExtractedPrompt(null)
    setError(null)
    streamingContentRef.current = ''
  }, [agentId, runner])

  const sendMessage = useCallback(
    async (text: string) => {
      if (!sessionIdRef.current || isStreaming) return
      const userMsg: ChatMessage = { role: 'user', content: text, timestamp: Date.now() }
      const assistantPlaceholder: ChatMessage = {
        role: 'assistant',
        content: '__streaming__',
        timestamp: Date.now(),
      }
      setMessages((prev) => [...prev, userMsg, assistantPlaceholder])
      setIsStreaming(true)
      setError(null)
      streamingContentRef.current = ''
      await api.promptChat.send(sessionIdRef.current, text)
    },
    [isStreaming]
  )

  const closeSession = useCallback(() => {
    const sid = sessionIdRef.current
    if (sid) {
      api.promptChat.close(sid).catch(console.error)
      setSessionId(null)
      sessionIdRef.current = null
    }
  }, [])

  return {
    messages,
    sessionId,
    isStreaming,
    extractedPrompt,
    error,
    startSession,
    sendMessage,
    closeSession,
    clearExtractedPrompt: () => setExtractedPrompt(null),
  }
}
