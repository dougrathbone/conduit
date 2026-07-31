import { describe, it, expect } from 'vitest'
import { resolveWorkerFactoryKind, KNOWN_WORKER_FACTORIES } from './index'
import { resolveWorkerServerUrl } from './cloudConfig'
import { resolveEksConfig } from './eksWorker'
import { resolveFargateConfig } from './fargateWorker'

describe('resolveWorkerFactoryKind', () => {
  it('defaults to local when unset', () => {
    expect(resolveWorkerFactoryKind({})).toBe('local')
  })

  it('accepts all known factories, case/whitespace-tolerant', () => {
    for (const kind of KNOWN_WORKER_FACTORIES) {
      expect(resolveWorkerFactoryKind({ CONDUIT_WORKER_FACTORY: ` ${kind.toUpperCase()} ` })).toBe(kind)
    }
  })

  it('falls back to local for unknown values', () => {
    expect(resolveWorkerFactoryKind({ CONDUIT_WORKER_FACTORY: 'kubernetes' })).toBe('local')
  })
})

describe('resolveWorkerServerUrl', () => {
  it('prefers explicit CONDUIT_SERVER_URL', () => {
    expect(resolveWorkerServerUrl({ CONDUIT_SERVER_URL: 'wss://workers.example.com/ws/worker' })).toBe(
      'wss://workers.example.com/ws/worker'
    )
  })

  it('derives wss from CONDUIT_BASE_URL', () => {
    expect(resolveWorkerServerUrl({ CONDUIT_BASE_URL: 'https://conduit.example.com' })).toBe(
      'wss://conduit.example.com/ws/worker'
    )
    expect(resolveWorkerServerUrl({ CONDUIT_BASE_URL: 'http://localhost:7456/' })).toBe(
      'ws://localhost:7456/ws/worker'
    )
  })

  it('throws when neither is set', () => {
    expect(() => resolveWorkerServerUrl({})).toThrow(/CONDUIT_SERVER_URL/)
  })
})

describe('resolveEksConfig', () => {
  const base = { CONDUIT_EKS_WORKER_IMAGE: 'conduit:latest', CONDUIT_SERVER_URL: 'wss://x/ws/worker' }

  it('requires a worker image', () => {
    expect(() => resolveEksConfig({ CONDUIT_SERVER_URL: 'wss://x' })).toThrow(/CONDUIT_EKS_WORKER_IMAGE/)
  })

  it('applies defaults', () => {
    const cfg = resolveEksConfig(base)
    expect(cfg.namespace).toBe('default')
    expect(cfg.tokenSecretName).toBe('conduit-worker-token')
    expect(cfg.tokenSecretKey).toBe('token')
    expect(cfg.imagePullPolicy).toBe('IfNotPresent')
    expect(cfg.resources).toBeUndefined()
  })

  it('builds resources only when requests/limits are set', () => {
    const cfg = resolveEksConfig({ ...base, CONDUIT_EKS_MEMORY_LIMIT: '4Gi' })
    expect(cfg.resources).toEqual({ requests: undefined, limits: { cpu: undefined, memory: '4Gi' } })
  })
})

describe('resolveFargateConfig', () => {
  const base = {
    CONDUIT_FARGATE_CLUSTER: 'conduit',
    CONDUIT_FARGATE_TASK_DEFINITION: 'conduit-worker:1',
    CONDUIT_FARGATE_SUBNETS: 'subnet-1, subnet-2',
    CONDUIT_SERVER_URL: 'wss://x/ws/worker',
  }

  it('requires cluster, task definition, and subnets', () => {
    expect(() => resolveFargateConfig({ CONDUIT_SERVER_URL: 'wss://x' })).toThrow(
      /CONDUIT_FARGATE_CLUSTER.*CONDUIT_FARGATE_TASK_DEFINITION.*CONDUIT_FARGATE_SUBNETS/
    )
  })

  it('applies defaults and parses lists', () => {
    const cfg = resolveFargateConfig(base)
    expect(cfg.containerName).toBe('worker')
    expect(cfg.subnets).toEqual(['subnet-1', 'subnet-2'])
    expect(cfg.assignPublicIp).toBe('ENABLED')
    expect(cfg.workerToken).toBeUndefined()
  })
})
