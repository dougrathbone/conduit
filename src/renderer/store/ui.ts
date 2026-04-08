import { create } from 'zustand'

type Theme = 'dark' | 'light' | 'system'

interface UIState {
  selectedAgentId: string | null
  activeRunId: string | null
  theme: Theme
  sidebarWidth: number
  showGlobalMcpManager: boolean
  showPublishTargets: boolean
  // Actions
  selectAgent: (id: string | null) => void
  setActiveRun: (id: string | null) => void
  setTheme: (theme: Theme) => void
  setSidebarWidth: (w: number) => void
  setShowGlobalMcpManager: (show: boolean) => void
  setShowPublishTargets: (show: boolean) => void
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

// ── URL routing helpers ───────────────────────────────────────────────────────

function readUrlState(): { agentId: string | null; globalMcps: boolean; publishTargets: boolean } {
  if (typeof window === 'undefined') return { agentId: null, globalMcps: false, publishTargets: false }
  const path = window.location.pathname
  const globalMcps = path === '/global-mcps'
  const publishTargets = path === '/publish-targets'
  const m = path.match(/^\/agents\/([^/]+)$/)
  return { agentId: m ? m[1] : null, globalMcps, publishTargets }
}

function pushUrl(path: string) {
  if (typeof window !== 'undefined' && window.location.pathname !== path) {
    window.history.pushState(null, '', path)
  }
}

const initialUrl = readUrlState()

export const useUIStore = create<UIState>((set) => ({
  selectedAgentId: initialUrl.agentId,
  activeRunId: null,
  theme: initialTheme,
  sidebarWidth: getStoredSidebarWidth(),
  showGlobalMcpManager: initialUrl.globalMcps,
  showPublishTargets: initialUrl.publishTargets,

  selectAgent: (id) => {
    pushUrl(id ? `/agents/${id}` : '/')
    set({ selectedAgentId: id, showGlobalMcpManager: false, showPublishTargets: false })
  },

  setActiveRun: (id) => set({ activeRunId: id }),

  setShowGlobalMcpManager: (show) => {
    pushUrl(show ? '/global-mcps' : '/')
    set({ showGlobalMcpManager: show, showPublishTargets: false })
  },

  setShowPublishTargets: (show) => {
    pushUrl(show ? '/publish-targets' : '/')
    set({ showPublishTargets: show, showGlobalMcpManager: false })
  },

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
