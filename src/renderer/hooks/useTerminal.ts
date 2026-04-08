import { useEffect, useRef, useCallback } from 'react'
import type { RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { api } from '@renderer/lib/ipc'

const darkTheme = {
  background: '#0d0d0d',
  foreground: '#e5e5e5',
  cursor: '#818cf8',
  cursorAccent: '#0d0d0d',
  selectionBackground: '#6366f130',
  black: '#1a1a1a',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#818cf8',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e5e5e5',
  brightBlack: '#404040',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#a5b4fc',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
}

const lightTheme = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#6366f1',
  cursorAccent: '#ffffff',
  selectionBackground: '#6366f120',
  black: '#1a1a1a',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#6366f1',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#e5e5e5',
  brightBlack: '#737373',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#818cf8',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#ffffff',
}

export interface UseTerminalReturn {
  terminal: Terminal | null
  write: (data: string) => void
  clear: () => void
  fit: () => void
}

export function useTerminal(
  containerRef: RefObject<HTMLDivElement>,
  theme: 'dark' | 'light'
): UseTerminalReturn {
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      theme: theme === 'dark' ? darkTheme : lightTheme,
      fontFamily: 'JetBrains Mono, Fira Code, Cascadia Code, monospace',
      fontSize: 13,
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      convertEol: true,
      allowTransparency: true,
      disableStdin: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon((_, url) => {
      api.shell.openExternal(url).catch(console.error)
    })

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const handleResize = () => fitAddon.fit()
    const ro = new ResizeObserver(handleResize)
    if (containerRef.current) ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef])

  // Update theme when it changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = theme === 'dark' ? darkTheme : lightTheme
    }
  }, [theme])

  const write = useCallback((data: string) => {
    terminalRef.current?.write(data)
  }, [])

  const clear = useCallback(() => {
    terminalRef.current?.clear()
  }, [])

  const fit = useCallback(() => {
    fitAddonRef.current?.fit()
  }, [])

  return { terminal: terminalRef.current, write, clear, fit }
}

export interface UseLiveTerminalOptions {
  runId: string | null
  containerRef: RefObject<HTMLDivElement>
  theme: 'dark' | 'light'
}

/**
 * Terminal hook that subscribes to live output for a given runId.
 */
export function useLiveTerminal({ runId, containerRef, theme }: UseLiveTerminalOptions) {
  const { terminal, write, clear, fit } = useTerminal(containerRef, theme)
  const currentRunIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!runId) return
    if (currentRunIdRef.current !== runId) {
      currentRunIdRef.current = runId
      clear()
    }

    const unsub = api.onOutput((payload) => {
      if (payload.runId !== runId) return
      for (const chunk of payload.chunks) {
        write(chunk)
      }
    })

    return () => unsub()
  }, [runId, write, clear])

  return { terminal, write, clear, fit }
}
