import {
  DelegatingLogger,
  createLogger,
  defaultResource,
  parseLogLevel,
  stdoutSink,
  type Logger,
} from '../../shared/logging'
import { resolveLoggingConfig } from './config'
import { startOtelLogs, type OtelLogsHandle } from './otel'

const delegating = new DelegatingLogger(
  createLogger({
    resource: defaultResource(),
    minLevel: parseLogLevel(process.env.CONDUIT_LOG_LEVEL),
    sinks: stdoutSink(),
  })
)

/** Process-wide structured logger. Import this everywhere; init swaps the inner. */
export const log: Logger = delegating

let otelHandle: OtelLogsHandle | undefined
let initialized = false

export interface LoggingStatus {
  stdout: boolean
  otlp: boolean
  serviceName: string
}

/**
 * Install stdout JSON logging and, when an OTLP endpoint is configured, the
 * OpenTelemetry Logs SDK. Safe to call once from `observability/instrument`.
 */
export function initLogging(env: NodeJS.ProcessEnv = process.env): LoggingStatus {
  const config = resolveLoggingConfig(env)
  if (initialized) {
    return { stdout: config.stdout, otlp: Boolean(otelHandle), serviceName: config.resource.serviceName }
  }
  initialized = true

  if (config.otlpUrl) {
    try {
      otelHandle = startOtelLogs(config)
    } catch (err) {
      process.stderr.write(`[logging] failed to start OTLP log exporter: ${String(err)}\n`)
      otelHandle = undefined
    }
  }

  const writeLine = config.stdout
    ? (line: string) => {
        process.stdout.write(line + '\n')
      }
    : () => {}

  delegating.setInner(
    createLogger({
      resource: config.resource,
      minLevel: config.minLevel,
      sinks: {
        writeLine,
        emitOtel: otelHandle ? (level, message, attributes) => otelHandle!.emit(level, message, attributes) : undefined,
        flush: (timeoutMs) => otelHandle?.flush(timeoutMs) ?? Promise.resolve(true),
      },
    })
  )

  return {
    stdout: config.stdout,
    otlp: Boolean(otelHandle),
    serviceName: config.resource.serviceName,
  }
}

/** Flush OTLP buffers (no-op when export is off). */
export function flushLogging(timeoutMs?: number): Promise<boolean> {
  return log.flush(timeoutMs)
}

/** Test-only: allow re-init in the same process. */
export function resetLoggingForTests(): void {
  initialized = false
  otelHandle = undefined
  delegating.setInner(
    createLogger({
      resource: defaultResource(),
      minLevel: 'info',
      sinks: stdoutSink(),
    })
  )
}
