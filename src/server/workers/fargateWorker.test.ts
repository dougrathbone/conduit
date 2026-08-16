import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ECSClient } from '@aws-sdk/client-ecs'
import type { RunSpec, WorkerEventSink, WorkerHandle } from '../../shared/worker'
import type { WorkerControlPlane } from '../workerControl'
import {
  FARGATE_WORKER_CPU,
  FARGATE_WORKER_MEMORY_MIB,
  FargateWorkerFactory,
  buildFargateEcsClientConfig,
  resolveFargateConfig,
  type FargateWorkerConfig,
} from './fargateWorker'

vi.mock('../observability', () => ({
  reporter: { captureException: vi.fn(), captureMessage: vi.fn() },
}))

const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/conduit/abcdef0123456789'
const ROLE_ARN = 'arn:aws:iam::123456789012:role/conduit-launcher'

const SPEC: RunSpec = {
  runId: 'run-1',
  agentId: 'agent-1',
  runner: 'claude',
  prompt: 'hello',
  env: {},
  workspace: { kind: 'ephemeral' },
}

const BASE_ENV = {
  CONDUIT_FARGATE_CLUSTER: 'conduit',
  CONDUIT_FARGATE_TASK_DEFINITION: 'conduit-worker:1',
  CONDUIT_FARGATE_SUBNETS: 'subnet-aaa, subnet-bbb',
  CONDUIT_SERVER_URL: 'wss://conduit.example.test/ws/worker',
}

function baseConfig(over: Partial<FargateWorkerConfig> = {}): FargateWorkerConfig {
  return {
    cluster: 'conduit',
    taskDefinition: 'conduit-worker:1',
    containerName: 'worker',
    subnets: ['subnet-aaa', 'subnet-bbb'],
    securityGroups: ['sg-aaa'],
    assignPublicIp: 'ENABLED',
    serverUrl: 'wss://conduit.example.test/ws/worker',
    connectTimeoutMs: 5_000,
    ...over,
  }
}

class FakeEcs {
  calls: { name: string; input: Record<string, unknown> }[] = []
  runTaskResponse: unknown = { tasks: [{ taskArn: TASK_ARN }], failures: [] }
  describeResponse: unknown = {
    tasks: [{ taskArn: TASK_ARN, lastStatus: 'STOPPED', desiredStatus: 'STOPPED' }],
  }
  stopImpl: () => Promise<unknown> = async () => ({})

  async send(command: { input?: unknown }): Promise<unknown> {
    const name = command.constructor.name
    this.calls.push({ name, input: (command.input ?? {}) as Record<string, unknown> })
    if (name === 'RunTaskCommand') return this.runTaskResponse
    if (name === 'StopTaskCommand') return this.stopImpl()
    if (name === 'DescribeTasksCommand') return this.describeResponse
    return {}
  }

  of(name: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.name === name).map((c) => c.input)
  }
}

function fakeControlPlane(
  over: {
    assignTo?: WorkerControlPlane['assignTo']
  } = {}
): {
  plane: WorkerControlPlane
  assignTo: ReturnType<typeof vi.fn>
  cancelAssignTo: ReturnType<typeof vi.fn>
  lastSink: () => WorkerEventSink
} {
  let lastSink: WorkerEventSink | undefined
  const assignTo = vi.fn(async (workerId: string, spec: RunSpec, sink: WorkerEventSink) => {
    lastSink = sink
    return {
      runId: spec.runId,
      ephemeral: false,
      workerId,
      cancel: vi.fn(async () => {}),
    } satisfies WorkerHandle
  })
  const cancelAssignTo = vi.fn()
  if (over.assignTo) assignTo.mockImplementation(over.assignTo)
  return {
    plane: { assignTo, cancelAssignTo } as unknown as WorkerControlPlane,
    assignTo,
    cancelAssignTo,
    lastSink: () => {
      if (!lastSink) throw new Error('assignTo was not called')
      return lastSink
    },
  }
}

function envNames(input: Record<string, unknown>): string[] {
  const overrides = input.overrides as {
    containerOverrides: { environment?: { name: string; value: string }[] }[]
  }
  return (overrides.containerOverrides[0].environment ?? []).map((e) => e.name)
}

describe('resolveFargateConfig', () => {
  it('requires cluster, task definition, and subnets', () => {
    expect(() => resolveFargateConfig({ CONDUIT_SERVER_URL: 'wss://x' })).toThrow(
      /CONDUIT_FARGATE_CLUSTER.*CONDUIT_FARGATE_TASK_DEFINITION.*CONDUIT_FARGATE_SUBNETS/
    )
  })

  it('reads connect and assign timeouts from the supplied env, not import-time globals', () => {
    const cfg = resolveFargateConfig({
      ...BASE_ENV,
      CONDUIT_WORKER_CONNECT_TIMEOUT_MS: '12000',
      CONDUIT_WORKER_ASSIGN_TIMEOUT_MS: '1500',
    })
    expect(cfg.connectTimeoutMs).toBe(12_000)
    expect(cfg.assignTimeoutMs).toBe(1_500)
  })

  it('parses optional CONDUIT_FARGATE_ROLE_ARN', () => {
    const cfg = resolveFargateConfig({ ...BASE_ENV, CONDUIT_FARGATE_ROLE_ARN: ROLE_ARN })
    expect(cfg.roleArn).toBe(ROLE_ARN)
  })

  it('omits roleArn when CONDUIT_FARGATE_ROLE_ARN is unset', () => {
    expect(resolveFargateConfig(BASE_ENV).roleArn).toBeUndefined()
  })
})

describe('buildFargateEcsClientConfig', () => {
  it('does not assume a role when roleArn is unset', () => {
    expect(buildFargateEcsClientConfig(baseConfig()).credentials).toBeUndefined()
  })

  it('assumes CONDUIT_FARGATE_ROLE_ARN for ECS calls', () => {
    const ecsConfig = buildFargateEcsClientConfig(baseConfig({ roleArn: ROLE_ARN }))
    expect(ecsConfig.credentials).toBeDefined()
  })
})

describe('FargateWorkerFactory', () => {
  let ecs: FakeEcs
  let cp: ReturnType<typeof fakeControlPlane>
  let factory: FargateWorkerFactory
  const sink: WorkerEventSink = { onEvent: () => {}, onExit: () => {} }

  beforeEach(() => {
    ecs = new FakeEcs()
    cp = fakeControlPlane()
    factory = new FargateWorkerFactory(cp.plane, baseConfig(), ecs as unknown as ECSClient)
  })

  it('sends an exact RunTask shape with startedBy, tags, and 2 vCPU / 8192 MiB', async () => {
    await factory.startRun(SPEC, sink)
    const input = ecs.of('RunTaskCommand')[0]
    expect(input).toMatchObject({
      cluster: 'conduit',
      taskDefinition: 'conduit-worker:1',
      launchType: 'FARGATE',
      startedBy: 'conduit',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ['subnet-aaa', 'subnet-bbb'],
          securityGroups: ['sg-aaa'],
          assignPublicIp: 'ENABLED',
        },
      },
      overrides: {
        cpu: FARGATE_WORKER_CPU,
        memory: FARGATE_WORKER_MEMORY_MIB,
        containerOverrides: [
          {
            name: 'worker',
            environment: [
              { name: 'CONDUIT_SERVER_URL', value: 'wss://conduit.example.test/ws/worker' },
              { name: 'CONDUIT_WORKER_ID', value: 'fargate-run-1' },
            ],
          },
        ],
      },
      tags: [
        { key: 'conduit:run-id', value: 'run-1' },
        { key: 'conduit:agent-id', value: 'agent-1' },
        { key: 'managed-by', value: 'conduit' },
      ],
    })
    expect(FARGATE_WORKER_CPU).toBe('2048')
    expect(FARGATE_WORKER_MEMORY_MIB).toBe('8192')
  })

  it('does not put CONDUIT_WORKER_TOKEN or CONDUIT_FARGATE_WORKER_TOKEN in overrides by default', async () => {
    await factory.startRun(SPEC, sink)
    const names = envNames(ecs.of('RunTaskCommand')[0])
    expect(names).not.toContain('CONDUIT_WORKER_TOKEN')
    expect(names).not.toContain('CONDUIT_FARGATE_WORKER_TOKEN')
  })

  it('allows a dev-only CONDUIT_WORKER_TOKEN override when workerToken is configured', async () => {
    factory = new FargateWorkerFactory(
      cp.plane,
      baseConfig({ workerToken: 'dev-only-token' }),
      ecs as unknown as ECSClient
    )
    await factory.startRun(SPEC, sink)
    const names = envNames(ecs.of('RunTaskCommand')[0])
    expect(names).toContain('CONDUIT_WORKER_TOKEN')
    expect(names).not.toContain('CONDUIT_FARGATE_WORKER_TOKEN')
  })

  it('fails startRun when RunTask throws', async () => {
    const original = ecs.send.bind(ecs)
    ecs.send = async (command) => {
      if (command.constructor.name === 'RunTaskCommand') {
        ecs.calls.push({ name: 'RunTaskCommand', input: (command.input ?? {}) as Record<string, unknown> })
        throw new Error('AccessDenied')
      }
      return original(command)
    }
    await expect(factory.startRun(SPEC, sink)).rejects.toThrow(/Failed to start Fargate task.*AccessDenied/)
  })

  it('fails startRun when RunTask returns no task ARN', async () => {
    ecs.runTaskResponse = { tasks: [], failures: [{ reason: 'RESOURCE:MEMORY', arn: 'cluster' }] }
    await expect(factory.startRun(SPEC, sink)).rejects.toThrow(/RESOURCE:MEMORY/)
  })

  it('passes the configured connect timeout to assignTo', async () => {
    await factory.startRun(SPEC, sink)
    expect(cp.assignTo).toHaveBeenCalledWith(
      'fargate-run-1',
      SPEC,
      expect.anything(),
      5_000
    )
  })

  it('fails startRun early when DescribeTasks reports STOPPED before the worker connects', async () => {
    ecs.describeResponse = {
      tasks: [
        {
          taskArn: TASK_ARN,
          lastStatus: 'STOPPED',
          stoppedReason: 'CannotPullContainerError: image not found',
        },
      ],
    }
    cp.assignTo.mockImplementation(() => new Promise(() => {}))
    const outcome = Promise.race([
      factory.startRun(SPEC, sink).then(
        () => 'settled',
        (err: Error) => err.message
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), 200)),
    ])
    await expect(outcome).resolves.toMatch(/CannotPullContainerError|STOPPED|image not found/)
    expect(cp.cancelAssignTo).toHaveBeenCalledWith(
      'fargate-run-1',
      expect.objectContaining({ message: expect.stringMatching(/CannotPullContainerError|STOPPED|image not found/) })
    )
  })

  it('does not leave an unhandled rejection when early STOPPED wins the assignTo race', async () => {
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      ecs.describeResponse = {
        tasks: [{ taskArn: TASK_ARN, lastStatus: 'STOPPED', stoppedReason: 'CannotPullContainerError' }],
      }
      let rejectAssign!: (err: Error) => void
      cp.assignTo.mockImplementation(() => new Promise((_, reject) => { rejectAssign = reject }))
      await expect(factory.startRun(SPEC, sink)).rejects.toThrow(/CannotPullContainerError|STOPPED/)
      rejectAssign(new Error('Worker fargate-run-1 did not connect within 5000ms'))
      await new Promise((r) => setTimeout(r, 20))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('keeps waiting for assignTo when DescribeTasks throws a transient error', async () => {
    const original = ecs.send.bind(ecs)
    ecs.send = async (command) => {
      if (command.constructor.name === 'DescribeTasksCommand') {
        ecs.calls.push({ name: 'DescribeTasksCommand', input: (command.input ?? {}) as Record<string, unknown> })
        throw new Error('ThrottlingException')
      }
      return original(command)
    }
    cp.assignTo.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              runId: SPEC.runId,
              ephemeral: false,
              workerId: 'fargate-run-1',
              cancel: vi.fn(async () => {}),
            } satisfies WorkerHandle)
          }, 80)
        })
    )
    const handle = await factory.startRun(SPEC, sink)
    expect(handle.runId).toBe('run-1')
    expect(ecs.of('DescribeTasksCommand').length).toBeGreaterThan(0)
    expect(cp.cancelAssignTo).not.toHaveBeenCalled()
  })

  it('StopTask on cancel and verifies STOPPED via DescribeTasks', async () => {
    const handle = await factory.startRun(SPEC, sink)
    await handle.cancel()
    expect(ecs.of('StopTaskCommand')[0]).toMatchObject({
      cluster: 'conduit',
      task: TASK_ARN,
    })
    expect(ecs.of('DescribeTasksCommand')[0]).toMatchObject({
      cluster: 'conduit',
      tasks: [TASK_ARN],
    })
  })

  it('StopTask on normal exit and verifies STOPPED', async () => {
    await factory.startRun(SPEC, sink)
    cp.lastSink().onExit('completed', 0)
    await vi.waitFor(
      () => {
        expect(ecs.of('StopTaskCommand').length).toBeGreaterThan(0)
        expect(ecs.of('DescribeTasksCommand').length).toBeGreaterThan(0)
      },
      { timeout: 200, interval: 20 }
    )
  })

  it('StopTask on failed exit and verifies STOPPED', async () => {
    await factory.startRun(SPEC, sink)
    cp.lastSink().onExit('failed', 1)
    await vi.waitFor(
      () => {
        expect(ecs.of('StopTaskCommand').length).toBeGreaterThan(0)
        expect(ecs.of('DescribeTasksCommand').length).toBeGreaterThan(0)
      },
      { timeout: 200, interval: 20 }
    )
  })

  it('StopTask when assignTo fails', async () => {
    cp.assignTo.mockRejectedValue(new Error('Worker fargate-run-1 did not connect within 50ms'))
    await expect(factory.startRun(SPEC, sink)).rejects.toThrow(/did not connect/)
    expect(ecs.of('StopTaskCommand')[0]).toMatchObject({ task: TASK_ARN })
  })

  it('stop is idempotent when the task is already gone', async () => {
    const handle = await factory.startRun(SPEC, sink)
    ecs.stopImpl = async () => {
      throw new Error('The referenced task was not found')
    }
    await expect(handle.cancel()).resolves.toBeUndefined()
    await expect(handle.cancel()).resolves.toBeUndefined()
  })

  it('shutdown StopTasks every in-flight run and verifies STOPPED', async () => {
    await factory.startRun(SPEC, sink)
    await factory.shutdown()
    expect(ecs.of('StopTaskCommand')[0]).toMatchObject({ task: TASK_ARN })
    expect(ecs.of('DescribeTasksCommand')[0]).toMatchObject({ tasks: [TASK_ARN] })
  })
})
