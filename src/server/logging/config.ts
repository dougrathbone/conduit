import { parseLogLevel, type LogLevel, type LogResource } from '../../shared/logging'
import { resolveProcessMode } from '../../shared/processMode'

export interface LoggingConfig {
  resource: LogResource
  minLevel: LogLevel
  stdout: boolean
  /** Absolute OTLP HTTP logs URL, or undefined when export is off. */
  otlpUrl?: string
  otlpHeaders: Record<string, string>
}

export function envFlag(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue
  const v = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return defaultValue
}

/** `OTEL_RESOURCE_ATTRIBUTES` is comma-separated `key=value` pairs. */
export function parseOtelResourceAttributes(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {}
  const out: Record<string, string> = {}
  for (const part of raw.split(',')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

/** `OTEL_EXPORTER_OTLP_HEADERS` / `_LOGS_HEADERS` is comma-separated `key=value`. */
export function parseOtelHeaders(raw: string | undefined): Record<string, string> {
  return parseOtelResourceAttributes(raw)
}

export function resolveServiceName(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OTEL_SERVICE_NAME?.trim()
  if (explicit) return explicit
  try {
    return resolveProcessMode(env) === 'worker' ? 'conduit-worker' : 'conduit'
  } catch {
    return 'conduit'
  }
}

export function resolveServiceVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromOtel = env.OTEL_SERVICE_VERSION?.trim()
  if (fromOtel) return fromOtel
  const fromRelease = env.SENTRY_RELEASE?.trim() || env.GIT_SHA?.trim()
  return fromRelease || undefined
}

export function resolveDeploymentEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const attrs = parseOtelResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES)
  const fromAttrs = attrs['deployment.environment.name'] || attrs['deployment.environment']
  if (fromAttrs) return fromAttrs
  const fromEnv = env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV?.trim()
  return fromEnv || undefined
}

export function resolveLogResource(env: NodeJS.ProcessEnv = process.env): LogResource {
  return {
    serviceName: resolveServiceName(env),
    serviceVersion: resolveServiceVersion(env),
    deploymentEnvironment: resolveDeploymentEnvironment(env),
  }
}

/**
 * Resolve the OTLP HTTP logs endpoint from the standard OpenTelemetry env vars.
 * Returns undefined when the SDK is disabled, logs export is `none`, or no
 * endpoint is configured — stdout JSON still works on its own.
 */
export function resolveOtlpLogsUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (envFlag(env.OTEL_SDK_DISABLED, false)) return undefined

  const exporters = (env.OTEL_LOGS_EXPORTER ?? 'otlp')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (!exporters.includes('otlp')) return undefined

  const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim()
  if (logsEndpoint) return logsEndpoint

  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (!base) return undefined
  return `${base.replace(/\/$/, '')}/v1/logs`
}

export function resolveLoggingConfig(env: NodeJS.ProcessEnv = process.env): LoggingConfig {
  const otlpUrl = resolveOtlpLogsUrl(env)
  return {
    resource: resolveLogResource(env),
    minLevel: parseLogLevel(env.CONDUIT_LOG_LEVEL || env.OTEL_LOG_LEVEL),
    stdout: envFlag(env.CONDUIT_LOG_STDOUT, true),
    otlpUrl,
    otlpHeaders: {
      ...parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
      ...parseOtelHeaders(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS),
    },
  }
}
