import { describe, it, expect } from 'vitest'
import { isWorkerOneShot, planAfterDisconnect, planAfterRunExit } from './oneShot'

describe('isWorkerOneShot', () => {
  it('is off when CONDUIT_WORKER_ONE_SHOT is unset', () => {
    expect(isWorkerOneShot({})).toBe(false)
  })

  it('is on for true/1/yes, case/whitespace-tolerant', () => {
    expect(isWorkerOneShot({ CONDUIT_WORKER_ONE_SHOT: 'true' })).toBe(true)
    expect(isWorkerOneShot({ CONDUIT_WORKER_ONE_SHOT: ' TRUE ' })).toBe(true)
    expect(isWorkerOneShot({ CONDUIT_WORKER_ONE_SHOT: '1' })).toBe(true)
    expect(isWorkerOneShot({ CONDUIT_WORKER_ONE_SHOT: 'yes' })).toBe(true)
  })

  it('is off for false/0/empty/other values', () => {
    expect(isWorkerOneShot({ CONDUIT_WORKER_ONE_SHOT: 'false' })).toBe(false)
    expect(isWorkerOneShot({ CONDUIT_WORKER_ONE_SHOT: '0' })).toBe(false)
    expect(isWorkerOneShot({ CONDUIT_WORKER_ONE_SHOT: '' })).toBe(false)
    expect(isWorkerOneShot({ CONDUIT_WORKER_ONE_SHOT: 'maybe' })).toBe(false)
  })
})

describe('one-shot lifecycle plans', () => {
  const oneShot = { CONDUIT_WORKER_ONE_SHOT: 'true' }

  it('pooled workers reconnect after disconnect and stay idle after a run', () => {
    expect(planAfterDisconnect({})).toBe('reconnect')
    expect(planAfterRunExit({})).toBe('idle')
  })

  it('one-shot workers reconnect after disconnect so unacked frames are not abandoned', () => {
    expect(planAfterDisconnect(oneShot)).toBe('reconnect')
  })

  it('one-shot workers wait to exit while any assigned run still has pending reliable delivery', () => {
    expect(planAfterRunExit(oneShot, { hasPendingDelivery: true })).toBe('idle')
  })

  it('one-shot workers exit only after pending reliable delivery is acknowledged', () => {
    expect(planAfterRunExit(oneShot, { hasPendingDelivery: false })).toBe('exit')
  })
})
