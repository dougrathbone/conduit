import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RunEventInit } from '../../shared/types'
import type { RunSpec, WorkerEventSink, WorkerExitStatus } from '../../shared/worker'
import { LocalWorkerFactory } from './localWorker'

/**
 * A stand-in `cursor-agent`. Without --resume it announces a session, then dies
 * the way the real CLI does when the Cursor API drops the stream. With --resume
 * it reads the continuation prompt from stdin and finishes. Every invocation's
 * argv + stdin is appended to $FAKE_LOG.
 */
const FAKE_CURSOR_AGENT = `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input }) + '\\n')
  const i = args.indexOf('--resume')
  const resumed = i >= 0
  const sid = 'sess-fake-1'
  const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\\n')
  out({ type: 'system', subtype: 'init', model: 'fake' })
  if (!resumed || process.env.FAKE_ALWAYS_DROP) {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } })
    process.stderr.write('RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)\\n')
    process.exit(1)
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'finished' }] } })
  out({ type: 'result', subtype: 'success', is_error: false })
  process.exit(0)
})
`

interface Harness {
  events: RunEventInit[]
  exit: Promise<{ status: WorkerExitStatus; code: number | null | undefined }>
  sink: WorkerEventSink
}

function harness(): Harness {
  const events: RunEventInit[] = []
  let resolve!: (v: { status: WorkerExitStatus; code: number | null | undefined }) => void
  const exit = new Promise<{ status: WorkerExitStatus; code: number | null | undefined }>((r) => (resolve = r))
  return {
    events,
    exit,
    sink: {
      onEvent: (e) => void events.push(e),
      onExit: (status, code) => resolve({ status, code }),
    },
  }
}

describe('LocalWorkerFactory cursor session resume', () => {
  let binDir: string
  let logFile: string

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-fake-cursor-'))
    logFile = path.join(binDir, 'invocations.jsonl')
    const bin = path.join(binDir, 'cursor-agent')
    fs.writeFileSync(bin, FAKE_CURSOR_AGENT, { mode: 0o755 })
  })

  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true })
  })

  const invocations = (): Array<{ args: string[]; input: string }> =>
    fs
      .readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))

  function spec(extraEnv: Record<string, string> = {}): RunSpec {
    return {
      runId: `resume-test-${Math.random().toString(36).slice(2)}`,
      agentId: 'agent-1',
      runner: 'cursor',
      prompt: 'do the original task',
      env: { PATH: `${binDir}${path.delimiter}${process.env.PATH}`, FAKE_LOG: logFile, ...extraEnv },
      workspace: { kind: 'ephemeral' },
    }
  }

  it('resumes the same session after the provider drops the stream, instead of failing the run', async () => {
    const factory = new LocalWorkerFactory({ resumeDelayMs: () => 5 })
    const h = harness()
    await factory.startRun(spec(), h.sink)

    expect(await h.exit).toEqual({ status: 'completed', code: 0 })

    const calls = invocations()
    expect(calls).toHaveLength(2)
    expect(calls[0].args).not.toContain('--resume')
    expect(calls[0].input).toBe('do the original task')
    expect(calls[1].args[calls[1].args.indexOf('--resume') + 1]).toBe('sess-fake-1')
    // The continuation prompt tells the agent to carry on, not restart.
    expect(calls[1].input).toMatch(/continue/i)
    expect(calls[1].input).not.toContain('do the original task')

    const system = h.events.filter((e) => e.kind === 'raw' && e.stream === 'system').map((e) => e.text)
    expect(system.some((t) => /resuming/i.test(t ?? ''))).toBe(true)
    expect(h.events.some((e) => e.kind === 'assistant' && e.text === 'finished')).toBe(true)
  })

  it('fails the run once the resume attempts are used up', async () => {
    const factory = new LocalWorkerFactory({ resumeDelayMs: () => 5, resumeMaxAttempts: 2 })
    const h = harness()
    await factory.startRun(spec({ FAKE_ALWAYS_DROP: '1' }), h.sink)

    expect(await h.exit).toEqual({ status: 'failed', code: 1 })
    // original + 2 resumes
    expect(invocations()).toHaveLength(3)
    // The CLI's own diagnostic is what the orchestrator classifies.
    const stderr = h.events.filter((e) => e.kind === 'raw' && e.stream === 'stderr').map((e) => e.text)
    expect(stderr[stderr.length - 1]).toContain('RetriableError')
  })

  it('does not resume when disabled', async () => {
    const factory = new LocalWorkerFactory({ resumeDelayMs: () => 5, resumeMaxAttempts: 0 })
    const h = harness()
    await factory.startRun(spec(), h.sink)

    expect(await h.exit).toEqual({ status: 'failed', code: 1 })
    expect(invocations()).toHaveLength(1)
  })

  it('does not respawn after the run is cancelled during the backoff', async () => {
    const factory = new LocalWorkerFactory({ resumeDelayMs: () => 300 })
    const h = harness()
    const handle = await factory.startRun(spec(), h.sink)

    // Wait for the first attempt to die and the backoff to begin.
    for (let i = 0; i < 100 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setTimeout(r, 100))
    await handle.cancel()

    // Same as a SIGTERM'd CLI: the orchestrator already finalized the run as
    // stopped, so this exit is a no-op for it.
    expect(await h.exit).toEqual({ status: 'failed', code: null })
    await new Promise((r) => setTimeout(r, 450))
    expect(invocations()).toHaveLength(1)
  })
})
