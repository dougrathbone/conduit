import { afterEach, describe, it, expect, vi } from 'vitest'
import { sendWsJson, createIdempotentShutdown } from './wsSend'

afterEach(() => {
  vi.useRealTimers()
})

describe('sendWsJson', () => {
  it('resolves when the WebSocket send callback fires without error so a write is distinct from an application ACK', async () => {
    let cb: ((err?: Error) => void) | undefined
    const socket = {
      readyState: 1,
      send: vi.fn((_data: string, onSent?: (err?: Error) => void) => {
        cb = onSent
      }),
    }
    const pending = sendWsJson(socket, { type: 'run:exit', runId: 'r1', status: 'completed' }, 200)
    expect(socket.send).toHaveBeenCalledOnce()
    cb?.()
    await expect(pending).resolves.toBeUndefined()
  })

  it('rejects on timeout if the send callback never fires', async () => {
    vi.useFakeTimers()
    const socket = {
      readyState: 1,
      send: vi.fn(),
    }
    const pending = sendWsJson(socket, { type: 'run:exit' }, 20)
    const rejected = expect(pending).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(20)
    await rejected
  })

  it('rejects when the socket is absent or not open', async () => {
    await expect(sendWsJson(null, { type: 'run:exit' }, 200)).rejects.toThrow(/not open/i)
    const closed = { readyState: 3, send: vi.fn() }
    await expect(sendWsJson(closed, { type: 'run:exit' }, 200)).rejects.toThrow(/not open/i)
    expect(closed.send).not.toHaveBeenCalled()
  })

  it('rejects when send throws before the callback', async () => {
    const socket = {
      readyState: 1,
      send: vi.fn(() => {
        throw new Error('write failed')
      }),
    }
    await expect(sendWsJson(socket, { type: 'run:exit' }, 200)).rejects.toThrow('write failed')
  })

  it('rejects when the send callback reports an error', async () => {
    const socket = {
      readyState: 1,
      send: vi.fn((_data: string, onSent?: (err?: Error) => void) => {
        onSent?.(new Error('callback failed'))
      }),
    }
    await expect(sendWsJson(socket, { type: 'run:exit' }, 200)).rejects.toThrow('callback failed')
  })
})

describe('createIdempotentShutdown', () => {
  it('runs the work once when shutdown is called concurrently', async () => {
    let runs = 0
    const shutdown = createIdempotentShutdown(async () => {
      runs++
      await new Promise((r) => setTimeout(r, 20))
    })
    await Promise.all([shutdown(), shutdown(), shutdown()])
    expect(runs).toBe(1)
  })

  it('uses the first exit code when shutdown is invoked concurrently with different codes', async () => {
    let code: number | undefined
    const shutdown = createIdempotentShutdown(async (exitCode) => {
      code = exitCode
    })
    await Promise.all([shutdown(1), shutdown(0)])
    expect(code).toBe(1)
  })
})
