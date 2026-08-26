/**
 * @vitest-environment jsdom
 */
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ExecutionRun } from '@shared/types'

const { startRun, stopRun } = vi.hoisted(() => ({
  startRun: vi.fn(),
  stopRun: vi.fn(),
}))

vi.mock('@renderer/lib/ipc', () => ({
  api: {
    runs: { start: startRun, stop: stopRun },
  },
}))

import { RunControls } from '@renderer/components/runs/RunControls'
import { useUIStore } from '@renderer/store/ui'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function makeRun(id: string): ExecutionRun {
  return { id, agentId: 'agent-a', status: 'running', startedAt: Date.now() } as ExecutionRun
}

/**
 * Renders the Run button the way MainPanel does: a single instance whose
 * `agentId` prop changes when another agent is selected. MainPanel is not keyed
 * by agent, so React reuses the component — and everything it holds.
 */
function renderForAgent(agentId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onRunStarted = vi.fn()
  const tree = (id: string) => (
    <QueryClientProvider client={client}>
      <RunControls
        agentId={id}
        activeRunId={null}
        activeRunStatus={null}
        activeRunStartedAt={null}
        onRunStarted={onRunStarted}
      />
    </QueryClientProvider>
  )
  const view = render(tree(agentId))
  return {
    onRunStarted,
    switchToAgent: (id: string) => {
      useUIStore.getState().selectAgent(id)
      view.rerender(tree(id))
    },
  }
}

const runButton = () => screen.getByRole('button', { name: /run/i }) as HTMLButtonElement

/** Presses Run and waits for the start to show as in progress. */
async function startAndWaitForPending() {
  await act(async () => {
    fireEvent.click(runButton())
  })
  await waitFor(() => expect(runButton().disabled).toBe(true))
}

describe('RunControls', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    useUIStore.setState({ selectedAgentId: 'agent-a', activeRunId: null, viewedRunId: null })
  })

  it('leaves the next agent runnable while a start is still in flight', async () => {
    const start = deferred<ExecutionRun>()
    startRun.mockReturnValue(start.promise)

    const { switchToAgent } = renderForAgent('agent-a')
    await startAndWaitForPending()

    switchToAgent('agent-b')

    // agent-a's in-flight start must not disable agent-b's Run button: starting
    // a run waits on the worker, which takes minutes for a cold cloud worker.
    expect(runButton().disabled).toBe(false)

    await act(async () => {
      start.resolve(makeRun('run-1'))
      await start.promise
    })
  })

  it('still shows the start as in progress on the agent it belongs to', async () => {
    const start = deferred<ExecutionRun>()
    startRun.mockReturnValue(start.promise)

    const { switchToAgent } = renderForAgent('agent-a')
    await startAndWaitForPending()

    switchToAgent('agent-b')
    switchToAgent('agent-a')

    expect(runButton().disabled).toBe(true)

    await act(async () => {
      start.resolve(makeRun('run-1'))
      await start.promise
    })
  })

  it('does not steer the view when the start resolves after switching agents', async () => {
    const start = deferred<ExecutionRun>()
    startRun.mockReturnValue(start.promise)

    const { switchToAgent, onRunStarted } = renderForAgent('agent-a')
    await startAndWaitForPending()
    switchToAgent('agent-b')

    await act(async () => {
      start.resolve(makeRun('run-1'))
      await start.promise
    })

    expect(useUIStore.getState().viewedRunId).toBeNull()
    expect(useUIStore.getState().activeRunId).toBeNull()
    expect(onRunStarted).not.toHaveBeenCalled()
  })

  it('opens the new run when it resolves on the agent that started it', async () => {
    const start = deferred<ExecutionRun>()
    startRun.mockReturnValue(start.promise)

    const { onRunStarted } = renderForAgent('agent-a')
    await startAndWaitForPending()

    await act(async () => {
      start.resolve(makeRun('run-1'))
      await start.promise
    })

    expect(useUIStore.getState().activeRunId).toBe('run-1')
    expect(useUIStore.getState().viewedRunId).toBe('run-1')
    expect(onRunStarted).toHaveBeenCalled()
  })
})
