const WS_OPEN = 1

export interface SendableSocket {
  readyState: number
  send: (data: string, cb?: (err?: Error) => void) => void
}

/** Send a JSON frame and wait for the WebSocket callback, with a bounded timeout. */
export function sendWsJson(
  socket: SendableSocket | null | undefined,
  msg: unknown,
  timeoutMs = 2_000
): Promise<void> {
  return new Promise((resolve) => {
    if (!socket || socket.readyState !== WS_OPEN) {
      resolve()
      return
    }
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    try {
      socket.send(JSON.stringify(msg), () => {
        clearTimeout(timer)
        done()
      })
    } catch {
      clearTimeout(timer)
      done()
    }
  })
}

/** Return a shutdown function that runs `work` at most once. */
export function createIdempotentShutdown(work: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    if (!pending) pending = work()
    return pending
  }
}
