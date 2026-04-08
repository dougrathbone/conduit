import { create } from 'zustand'

type Theme = 'dark' | 'light' | 'system'

interface UIState {
  selectedAgentId: string | null
  activeRunId: string | null
  theme: Theme
  sidebarWidth: number
  showGlobalMcpManager: boolean
  // Actions
  selectAgent: (id: string | null) => void
  setActiveRun: (id: string | null) => void
  setTheme: (theme: Theme) => void
  setSidebarWidth: (w: number) => void
  setShowGlobalMcpManager: (show: boolean) => void
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'dark') {
    root.classList.add('dark')
  } else if (theme === 'light') {
    root.classList.remove('dark')
  } else {
    // system
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    if (prefersDark) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }
}

function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem('conduit-theme')
    if (stored === 'dark' || stored === 'light' || stored === 'system') {
      return stored
    }
  } catch {
    // ignore
  }
  return 'dark'
}

function getStoredSidebarWidth(): number {
  try {
    const stored = localStorage.getItem('conduit-sidebar-width')
    if (stored) {
      const w = parseInt(stored, 10)
      if (!isNaN(w) && w >= 180 && w <= 480) return w
    }
  } catch {
    // ignore
  }
  return 260
}

const initialTheme = getStoredTheme()
// Apply theme immediately on module load
if (typeof document !== 'undefined') {
  applyTheme(initialTheme)
}

export const useUIStore = create<UIState>((set) => ({
  selectedAgentId: null,
  activeRunId: null,
  theme: initialTheme,
  sidebarWidth: getStoredSidebarWidth(),
  showGlobalMcpManager: false,

  selectAgent: (id) => set({ selectedAgentId: id, showGlobalMcpManager: false }),

  setActiveRun: (id) => set({ activeRunId: id }),

  setShowGlobalMcpManager: (show) => set({ showGlobalMcpManager: show }),

  setTheme: (theme) => {
    try {
      localStorage.setItem('conduit-theme', theme)
    } catch {
      // ignore
    }
    applyTheme(theme)
    set({ theme })
  },

  setSidebarWidth: (w) => {
    try {
      localStorage.setItem('conduit-sidebar-width', String(w))
    } catch {
      // ignore
    }
    set({ sidebarWidth: w })
  },
}))
