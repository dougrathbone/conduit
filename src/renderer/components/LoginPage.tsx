import React from 'react'

export function LoginPage() {
  return (
    <div
      className="flex flex-col items-center justify-center h-screen w-screen gap-6"
      style={{ background: 'var(--bg-primary)' }}
    >
      <div className="text-center space-y-2">
        <h1
          className="text-2xl font-bold tracking-wide"
          style={{ color: 'var(--accent)', fontFamily: 'monospace' }}
        >
          &gt;_conduit
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Sign in to manage your AI agents
        </p>
      </div>
      <a
        href="/auth/login"
        className="px-6 py-2.5 rounded-lg text-sm font-medium transition-colors"
        style={{
          background: 'var(--accent)',
          color: 'var(--accent-fg)',
        }}
      >
        Sign in with Okta
      </a>
    </div>
  )
}
