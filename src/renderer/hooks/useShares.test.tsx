/**
 * @vitest-environment jsdom
 */
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShareableEntityType } from '@shared/types'

const mocks = vi.hoisted(() => ({
  onShareChange: vi.fn(),
  unsubscribe: vi.fn(),
}))

vi.mock('@renderer/lib/ipc', () => ({
  api: {
    onShareChange: mocks.onShareChange,
  },
}))

import { useShareChangeInvalidation } from './useShares'

let listener: (payload: { entityType: ShareableEntityType; entityId: string }) => void

function Listener() {
  useShareChangeInvalidation()
  return null
}

describe('useShareChangeInvalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.onShareChange.mockImplementation(
      (callback: (payload: { entityType: ShareableEntityType; entityId: string }) => void) => {
        listener = callback
        return mocks.unsubscribe
      }
    )
  })

  afterEach(cleanup)

  it.each([
    ['agent', ['agents']],
    ['globalMcpServer', ['globalMcps']],
  ] as const)('refreshes the %s list when another user changes its visibility', (entityType, listKey) => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const view = render(
      <QueryClientProvider client={queryClient}>
        <Listener />
      </QueryClientProvider>
    )

    act(() => {
      listener({ entityType, entityId: 'shared-entity' })
    })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: listKey })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['shares', entityType, 'shared-entity'],
    })

    view.unmount()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })
})
