import React, { useState, useRef, useEffect } from 'react'
import { LogOut, User as UserIcon } from 'lucide-react'
import { useAuth } from '@renderer/contexts/AuthContext'

export function UserMenu() {
  const { user, isDevMode, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  if (!user) return null

  if (isDevMode) {
    return (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded font-medium"
        style={{
          background: 'var(--bg-secondary)',
          color: 'var(--text-secondary)',
        }}
      >
        DEV
      </span>
    )
  }

  const initials = user.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md p-1 hover:bg-[var(--bg-secondary)] transition-colors"
        title={user.name}
      >
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt={user.name}
            className="h-5 w-5 rounded-full"
          />
        ) : (
          <span
            className="flex items-center justify-center h-5 w-5 rounded-full text-[10px] font-medium"
            style={{
              background: 'var(--accent)',
              color: 'var(--accent-fg)',
            }}
          >
            {initials}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-48 rounded-lg border shadow-lg z-50 py-1"
          style={{
            background: 'var(--bg-primary)',
            borderColor: 'var(--border)',
          }}
        >
          <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
            <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
              {user.name}
            </p>
            <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
              {user.email}
            </p>
          </div>
          <button
            onClick={() => {
              setOpen(false)
              logout()
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--bg-secondary)] transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            <LogOut className="h-3 w-3" />
            Sign Out
          </button>
        </div>
      )}
    </div>
  )
}
