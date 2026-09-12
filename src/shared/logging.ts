/**
 * Structured logging contract shared by the server and conduit-worker.
 *
 * Types, JSON line formatting, and the logger interface live here with no SDK
 * imports so call sites stay backend-agnostic. The Node process installs an
 * OpenTelemetry Logs SDK behind `log` at startup (`src/server/logging/`) and
 * optionally exports OTLP — Datadog, Grafana, Honeycomb, or a collector all
 * speak that protocol. Without an OTLP endpoint, one JSON line per event still
 * goes to stdout for whatever tails the process (kube, journald, CloudWatch).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/** Well-known fields. Extra keys are allowed and pass through as attributes. */
export interface LogFields {
  runId?: string
  agentId?: string
  workerId?: string
  channel?: string
  component?: string
  err?: unknown
  [key: string]: unknown
}

export interface LogResource {
  serviceName: string
  serviceVersion?: string
  deploymentEnvironment?: string
}

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  child(fields: LogFields): Logger
  flush(timeoutMs?: number): Promise<boolean>
}

export interface SerializedException {
  'exception.type': string
  'exception.message': string
  'exception.stacktrace'?: string
}

export interface SerializedLogLine {
  timestamp: string
  severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  level: LogLevel
  body: string
  message: string
  'service.name': string
  'service.version'?: string
  'deployment.environment.name'?: string
  [key: string]: unknown
}

export function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase()
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value
  return 'info'
}

export function isLevelEnabled(level: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minLevel]
}

export function serializeException(err: unknown): SerializedException {
  if (err instanceof Error) {
    return {
      'exception.type': err.name,
      'exception.message': err.message,
      ...(err.stack ? { 'exception.stacktrace': err.stack } : {}),
    }
  }
  if (typeof err === 'string') {
    return { 'exception.type': 'Error', 'exception.message': err }
  }
  try {
    return { 'exception.type': 'Error', 'exception.message': JSON.stringify(err) }
  } catch {
    return { 'exception.type': 'Error', 'exception.message': String(err) }
  }
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) return serializeException(value)
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const safe = jsonSafe(v)
      if (safe !== undefined) out[k] = safe
    }
    return out
  }
  return String(value)
}

/**
 * Flatten a log event into one JSON-serializable object. Resource keys use
 * OpenTelemetry semantic conventions so stdout and OTLP stay aligned.
 */
export function formatLogRecord(input: {
  timestamp?: Date
  level: LogLevel
  message: string
  resource: LogResource
  fields?: LogFields
}): SerializedLogLine {
  const { err, ...rest } = input.fields ?? {}
  const attributes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue
    attributes[key] = jsonSafe(value)
  }
  const line: SerializedLogLine = {
    timestamp: (input.timestamp ?? new Date()).toISOString(),
    severity: input.level.toUpperCase() as SerializedLogLine['severity'],
    level: input.level,
    body: input.message,
    message: input.message,
    'service.name': input.resource.serviceName,
    ...attributes,
  }
  if (input.resource.serviceVersion) line['service.version'] = input.resource.serviceVersion
  if (input.resource.deploymentEnvironment) {
    line['deployment.environment.name'] = input.resource.deploymentEnvironment
  }
  if (err !== undefined) Object.assign(line, serializeException(err))
  return line
}

export function formatLogLine(input: Parameters<typeof formatLogRecord>[0]): string {
  return JSON.stringify(formatLogRecord(input))
}

export interface LoggerSinks {
  writeLine: (line: string) => void
  emitOtel?: (level: LogLevel, message: string, attributes: Record<string, unknown>) => void
  flush?: (timeoutMs?: number) => Promise<boolean>
}

export function createLogger(opts: {
  resource: LogResource
  minLevel: LogLevel
  sinks: LoggerSinks
}): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (!isLevelEnabled(level, opts.minLevel)) return
    const record = formatLogRecord({ level, message, resource: opts.resource, fields })
    try {
      opts.sinks.writeLine(JSON.stringify(record))
    } catch (err) {
      // Last-resort diagnostic; never throw from a log call.
      process.stderr.write(`[logging] failed to write log line: ${String(err)}\n`)
    }
    if (opts.sinks.emitOtel) {
      const { timestamp: _ts, severity: _sev, level: _lvl, body: _body, message: _msg, ...attributes } =
        record
      try {
        opts.sinks.emitOtel(level, message, attributes)
      } catch (err) {
        process.stderr.write(`[logging] OTLP emit failed: ${String(err)}\n`)
      }
    }
  }

  const logger: Logger = {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child(fields) {
      return createChildLogger(logger, fields)
    },
    flush(timeoutMs) {
      return opts.sinks.flush ? opts.sinks.flush(timeoutMs) : Promise.resolve(true)
    },
  }
  return logger
}

function createChildLogger(parent: Logger, bound: LogFields): Logger {
  const merge = (fields?: LogFields): LogFields => ({ ...bound, ...fields })
  return {
    debug: (message, fields) => parent.debug(message, merge(fields)),
    info: (message, fields) => parent.info(message, merge(fields)),
    warn: (message, fields) => parent.warn(message, merge(fields)),
    error: (message, fields) => parent.error(message, merge(fields)),
    child: (fields) => createChildLogger(parent, merge(fields)),
    flush: (timeoutMs) => parent.flush(timeoutMs),
  }
}

/**
 * Stable handle whose identity never changes. `setInner` swaps the real
 * implementation after SDK init — same pattern as `DelegatingReporter`.
 */
export class DelegatingLogger implements Logger {
  constructor(private inner: Logger) {}

  setInner(inner: Logger): void {
    this.inner = inner
  }

  debug(message: string, fields?: LogFields): void {
    this.inner.debug(message, fields)
  }
  info(message: string, fields?: LogFields): void {
    this.inner.info(message, fields)
  }
  warn(message: string, fields?: LogFields): void {
    this.inner.warn(message, fields)
  }
  error(message: string, fields?: LogFields): void {
    this.inner.error(message, fields)
  }
  child(fields: LogFields): Logger {
    return createChildLogger(this, fields)
  }
  flush(timeoutMs?: number): Promise<boolean> {
    return this.inner.flush(timeoutMs)
  }
}

export function defaultResource(): LogResource {
  return { serviceName: 'conduit' }
}

export function stdoutSink(): LoggerSinks {
  return {
    writeLine(line) {
      process.stdout.write(line + '\n')
    },
  }
}
