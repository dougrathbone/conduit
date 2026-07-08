import React, { createContext, useContext, useState, useEffect } from 'react'
import type { User, Group, AuthState } from '@shared/types'
import { reporter } from '@renderer/observability'

const AuthContext = createContext<AuthState & { logout: () => Promise<void> }>({
  user: null,
  groups: [],
  isAuthenticated: false,
  isDevMode: false,
  logout: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState & { isLoading: boolean }>({
    user: null,
    groups: [],
    isAuthenticated: false,
    isDevMode: false,
    isLoading: true,
  })

  useEffect(() => {
    fetch('/auth/me')
      .then((res) => {
        if (!res.ok) throw new Error('Not authenticated')
        return res.json()
      })
      .then((data: { user: User; groups: Group[]; isDevMode: boolean }) => {
        setState({
          user: data.user,
          groups: data.groups,
          isAuthenticated: true,
          isDevMode: data.isDevMode,
          isLoading: false,
        })
      })
      .catch(() => {
        setState((prev) => ({ ...prev, isLoading: false }))
      })
  }, [])

  // Attach the authenticated user to the error reporter (and clear it on logout)
  // so captured events are attributed to whoever hit them.
  useEffect(() => {
    if (state.user) {
      reporter.setUser({ id: state.user.id, email: state.user.email })
    } else {
      reporter.setUser(null)
    }
  }, [state.user])

  // Proactively detect a session that dies while the app is open, so the user is
  // sent to login without having to manually refresh. Re-check on tab focus /
  // visibility (catches the common "came back to the tab" case) plus a periodic
  // poll as a backstop. Only meaningful when auth is enabled — in dev-bypass mode
  // /auth/me is always authenticated, so there is nothing to detect.
  useEffect(() => {
    if (!state.isAuthenticated || state.isDevMode) return

    let redirecting = false
    const checkAuth = async () => {
      if (redirecting) return
      try {
        const res = await fetch('/auth/me')
        if (res.status === 401 && !redirecting) {
          redirecting = true
          window.location.assign('/auth/login')
        }
      } catch {
        // transient network error — leave it for the next tick
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') checkAuth()
    }
    window.addEventListener('focus', checkAuth)
    document.addEventListener('visibilitychange', onVisibility)
    const interval = window.setInterval(checkAuth, 60_000)

    return () => {
      window.removeEventListener('focus', checkAuth)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(interval)
    }
  }, [state.isAuthenticated, state.isDevMode])

  const logout = async () => {
    await fetch('/auth/logout', { method: 'POST' })
    window.location.reload()
  }

  if (state.isLoading) {
    return (
      <div
        className="flex items-center justify-center h-screen w-screen"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}
      >
        <span className="text-sm">Loading...</span>
      </div>
    )
  }

  return (
    <AuthContext.Provider value={{ ...state, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
