import { describe, it, expect } from 'vitest'
import {
  envFlag,
  parseOtelHeaders,
  parseOtelResourceAttributes,
  resolveDeploymentEnvironment,
  resolveLoggingConfig,
  resolveOtlpLogsUrl,
  resolveServiceName,
  resolveServiceVersion,
} from './config'

describe('envFlag', () => {
  it('uses the default when unset', () => {
    expect(envFlag(undefined, true)).toBe(true)
    expect(envFlag('  ', false)).toBe(false)
  })

  it('parses common truthy/falsey tokens', () => {
    expect(envFlag('TRUE', false)).toBe(true)
    expect(envFlag('0', true)).toBe(false)
    expect(envFlag('no', true)).toBe(false)
  })
})

describe('parseOtelResourceAttributes', () => {
  it('parses comma-separated key=value pairs', () => {
    expect(parseOtelResourceAttributes('deployment.environment=prod,team=platform')).toEqual({
      'deployment.environment': 'prod',
      team: 'platform',
    })
  })
})

describe('parseOtelHeaders', () => {
  it('parses OTLP header lists', () => {
    expect(parseOtelHeaders('Authorization=Bearer abc,x-foo=bar')).toEqual({
      Authorization: 'Bearer abc',
      'x-foo': 'bar',
    })
  })
})

describe('resolveServiceName', () => {
  it('prefers OTEL_SERVICE_NAME', () => {
    expect(resolveServiceName({ OTEL_SERVICE_NAME: 'custom', CONDUIT_PROCESS_MODE: 'worker' })).toBe(
      'custom'
    )
  })

  it('uses conduit-worker when process mode is worker', () => {
    expect(resolveServiceName({ CONDUIT_PROCESS_MODE: 'worker' })).toBe('conduit-worker')
    expect(resolveServiceName({ CONDUIT_PROCESS_MODE: 'server' })).toBe('conduit')
    expect(resolveServiceName({})).toBe('conduit')
  })
})

describe('resolveServiceVersion', () => {
  it('prefers OTEL_SERVICE_VERSION over GIT_SHA', () => {
    expect(resolveServiceVersion({ OTEL_SERVICE_VERSION: '1.2.3', GIT_SHA: 'deadbeef' })).toBe('1.2.3')
    expect(resolveServiceVersion({ GIT_SHA: 'deadbeef' })).toBe('deadbeef')
  })
})

describe('resolveDeploymentEnvironment', () => {
  it('reads deployment.environment.name from resource attributes', () => {
    expect(
      resolveDeploymentEnvironment({ OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=staging' })
    ).toBe('staging')
  })

  it('falls back to SENTRY_ENVIRONMENT then NODE_ENV', () => {
    expect(resolveDeploymentEnvironment({ SENTRY_ENVIRONMENT: 'prod', NODE_ENV: 'development' })).toBe(
      'prod'
    )
    expect(resolveDeploymentEnvironment({ NODE_ENV: 'test' })).toBe('test')
  })
})

describe('resolveOtlpLogsUrl', () => {
  it('is off when no endpoint is set', () => {
    expect(resolveOtlpLogsUrl({})).toBeUndefined()
  })

  it('appends /v1/logs to the base OTLP endpoint', () => {
    expect(resolveOtlpLogsUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(
      'http://collector:4318/v1/logs'
    )
  })

  it('prefers the logs-specific endpoint', () => {
    expect(
      resolveOtlpLogsUrl({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://logs:4318/v1/logs',
      })
    ).toBe('http://logs:4318/v1/logs')
  })

  it('stays off when the SDK is disabled or logs exporter excludes otlp', () => {
    expect(
      resolveOtlpLogsUrl({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_SDK_DISABLED: 'true',
      })
    ).toBeUndefined()
    expect(
      resolveOtlpLogsUrl({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_LOGS_EXPORTER: 'none',
      })
    ).toBeUndefined()
  })
})

describe('resolveLoggingConfig', () => {
  it('defaults to JSON stdout with no OTLP', () => {
    const cfg = resolveLoggingConfig({ CONDUIT_PROCESS_MODE: 'server' })
    expect(cfg.stdout).toBe(true)
    expect(cfg.otlpUrl).toBeUndefined()
    expect(cfg.resource.serviceName).toBe('conduit')
    expect(cfg.minLevel).toBe('info')
  })

  it('honors CONDUIT_LOG_STDOUT=false', () => {
    expect(resolveLoggingConfig({ CONDUIT_LOG_STDOUT: 'false' }).stdout).toBe(false)
  })
})
