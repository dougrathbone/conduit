import React, { useCallback, useState } from 'react'
import { Lock, CheckCircle2, AlertTriangle, Loader2, LogOut } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  useMcpToken,
  useStartMcpAuth,
  useRevokeMcpToken,
  useMcpOAuthListener,
} from '@renderer/hooks/useMcpOAuth'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@renderer/lib/utils'

export interface McpOAuthButtonProps {
  /** For global MCPs: the GlobalMcpServer.id.
   *  For agent MCPs: "{agentId}:{serverKey}" */
  serverId: string
  isGlobal: boolean
  /** The MCP server URL — used for token lookup */
  serverUrl: string
  /** Display name shown in status text */
  serverName: string
}

export function McpOAuthButton({
  serverId,
  isGlobal,
  serverUrl,
  serverName,
}: McpOAuthButtonProps) {
  const queryClient = useQueryClient()
  const [authInProgress, setAuthInProgress] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)

  const { data: token, isLoading: tokenLoading } = useMcpToken(serverUrl)
  const startAuth = useStartMcpAuth()
  const revokeToken = useRevokeMcpToken()

  // Listen for OAuth completion events from main process
  const handleComplete = useCallback(
    (result: { serverUrl: string; success: boolean; error?: string }) => {
      if (result.serverUrl !== serverUrl) return
      setAuthInProgress(false)
      if (result.success) {
        setLastError(null)
      } else {
        setLastError(result.error ?? 'Authentication failed')
      }
      queryClient.invalidateQueries({ queryKey: ['mcpToken', serverUrl] })
    },
    [serverUrl, queryClient]
  )

  useMcpOAuthListener(handleComplete)

  const handleAuthenticate = () => {
    setLastError(null)
    setAuthInProgress(true)
    startAuth.mutate(
      { serverId, isGlobal },
      {
        onError: (err) => {
          setAuthInProgress(false)
          setLastError(err instanceof Error ? err.message : String(err))
        },
      }
    )
  }

  const handleRevoke = () => {
    revokeToken.mutate(serverUrl)
  }

  if (tokenLoading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Checking…</span>
      </div>
    )
  }

  const isExpired = token?.expiresAt !== undefined && token.expiresAt <= Date.now()
  const isValid = !!token && !isExpired

  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {authInProgress ? (
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Authenticating…</span>
        </div>
      ) : isValid ? (
        <>
          <span
            className={cn(
              'flex items-center gap-1 text-xs font-medium',
              'text-emerald-500'
            )}
            title={
              token.expiresAt
                ? `Expires ${new Date(token.expiresAt).toLocaleString()}`
                : 'No expiry'
            }
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Authenticated
          </span>
          <button
            onClick={handleRevoke}
            disabled={revokeToken.isPending}
            title={`Revoke token for ${serverName}`}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-[var(--text-secondary)] hover:text-red-400 hover:bg-red-400/10 transition-colors"
          >
            {revokeToken.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <LogOut className="h-3 w-3" />
            )}
            Revoke
          </button>
        </>
      ) : isExpired ? (
        <Button
          size="sm"
          variant="outline"
          onClick={handleAuthenticate}
          className="gap-1.5 text-amber-500 border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-400"
          title={`Token for ${serverName} has expired — re-authenticate`}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          Re-authenticate
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={handleAuthenticate}
          className="gap-1.5"
          title={`Authenticate ${serverName} via OAuth`}
        >
          <Lock className="h-3.5 w-3.5" />
          Authenticate
        </Button>
      )}

      {lastError && (
        <span
          className="text-xs text-red-400 max-w-[160px] truncate"
          title={lastError}
        >
          {lastError}
        </span>
      )}
    </div>
  )
}
