import { logs, SeverityNumber, type Logger as OtelLogger } from '@opentelemetry/api-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import type { LogLevel } from '../../shared/logging'
import { parseOtelResourceAttributes, type LoggingConfig } from './config'

const SEVERITY: Record<LogLevel, { number: SeverityNumber; text: string }> = {
  debug: { number: SeverityNumber.DEBUG, text: 'DEBUG' },
  info: { number: SeverityNumber.INFO, text: 'INFO' },
  warn: { number: SeverityNumber.WARN, text: 'WARN' },
  error: { number: SeverityNumber.ERROR, text: 'ERROR' },
}

export interface OtelLogsHandle {
  emit(level: LogLevel, message: string, attributes: Record<string, unknown>): void
  flush(timeoutMs?: number): Promise<boolean>
  shutdown(): Promise<void>
}

function toOtelAttributeValue(value: unknown): string | number | boolean | string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Start the OpenTelemetry Logs SDK with an OTLP/HTTP exporter. Call sites never
 * import this module — they use `log` from `./index`. Any OTLP collector
 * (Datadog agent, Grafana Alloy, the contrib collector, …) can receive these.
 */
export function startOtelLogs(config: LoggingConfig): OtelLogsHandle | undefined {
  if (!config.otlpUrl) return undefined

  const extra = parseOtelResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES)
  const resource = resourceFromAttributes({
    ...extra,
    [ATTR_SERVICE_NAME]: config.resource.serviceName,
    ...(config.resource.serviceVersion ? { [ATTR_SERVICE_VERSION]: config.resource.serviceVersion } : {}),
    ...(config.resource.deploymentEnvironment
      ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.resource.deploymentEnvironment }
      : {}),
  })

  const exporter = new OTLPLogExporter({
    url: config.otlpUrl,
    headers: config.otlpHeaders,
  })
  const provider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor(exporter)],
  })
  logs.setGlobalLoggerProvider(provider)
  const otelLogger: OtelLogger = logs.getLogger(config.resource.serviceName)

  return {
    emit(level, message, attributes) {
      const sev = SEVERITY[level]
      const attrs: Record<string, string | number | boolean | string[]> = {}
      for (const [key, value] of Object.entries(attributes)) {
        const converted = toOtelAttributeValue(value)
        if (converted !== undefined) attrs[key] = converted
      }
      otelLogger.emit({
        severityNumber: sev.number,
        severityText: sev.text,
        body: message,
        attributes: attrs,
      })
    },
    async flush(timeoutMs = 2000) {
      const flush = provider.forceFlush()
      const timed = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs)
        t.unref?.()
        void flush.then(
          () => {
            clearTimeout(t)
            resolve(true)
          },
          () => {
            clearTimeout(t)
            resolve(false)
          }
        )
      })
      return timed
    },
    shutdown() {
      return provider.shutdown()
    },
  }
}
