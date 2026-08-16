import { describe, it, expect, vi } from 'vitest'
import { sendWsJson, createIdempotentShutdown } from './wsSend'

describe('sendWsJson', () => {
  it('resolves when the WebSocket send callback fires', async () => {
    let cb: ((err?: Error) => void) | undefined
    const socket = {
      readyState: 1,
      send: vi.fn((_data: string, onSent?: (err?: Error) => void) => {
        cb = onSent
      }),
    }
    const pending = sendWsJson(socket, { type: 'run:exit', runId: 'r1', status: 'completed' }, 200)
    expect(socket.send).toHaveBeenCalledOnce()
    expect(pending).toBeInstanceOf(Promise)
    cb?.()
    await expect(pending).resolves.toBeUndefined()
  })

  it('resolves on timeout if the send callback never fires', async () => {
    const socket = {
      readyState: 1,
      send: vi.fn(),
    }
    await expect(sendWsJson(socket, { type: 'run:exit' }, 20)).resolves.toBeUndefined()
  })

  it('resolves immediately when the socket is not open', async () => {
    const socket = { readyState: 3, send: vi.fn() }
    await expect(sendWsJson(socket, { type: 'run:exit' }, 200)).resolves.toBeUndefined()
    expect(socket.send).not.toHaveBeenCalled()
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
})
