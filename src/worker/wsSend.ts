const WS_OPEN = 1

export interface SendableSocket {
  readyState: number
  send: (data: string, cb?: (err?: Error) => void) => void
}

/**
 * Send a JSON frame and wait for the WebSocket callback, with a bounded timeout.
 *
 * Resolving means the frame was written to this socket — not that the server
 * applied it. Rejects when there is no open socket, send throws, the callback
 * reports an error, or the timeout expires.
 */
export function sendWsJson(
  socket: SendableSocket | null | undefined,
  msg: unknown,
  timeoutMs = 2_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WS_OPEN) {
      reject(new Error('WebSocket is not open'))
      return
    }
    let settled = false
    const succeed = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error('WebSocket send timed out')), timeoutMs)
    try {
      socket.send(JSON.stringify(msg), (err) => {
        clearTimeout(timer)
        if (err) fail(err instanceof Error ? err : new Error(String(err)))
        else succeed()
      })
    } catch (err) {
      clearTimeout(timer)
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/** Return a shutdown function that runs `work` at most once. The first exit code wins. */
export function createIdempotentShutdown(
  work: (exitCode: number) => Promise<void>
): (exitCode?: number) => Promise<void> {
  let pending: Promise<void> | undefined
  return (exitCode = 0) => {
    if (!pending) pending = work(exitCode)
    return pending
  }
}
