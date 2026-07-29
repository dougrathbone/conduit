import * as fs from 'fs'
import * as os from 'os'
import { reporter } from './observability'

/**
 * Memory-pressure telemetry — the counterpart to the disk-pressure telemetry in
 * dataDirSweeper.
 *
 * A heavy run (many parallel subagent worktrees each spawning node/yarn/test
 * processes on a large monorepo) can exhaust the pod's memory and get the whole
 * Conduit process OOM-killed mid-run. That death is invisible: the child-close
 * handler never runs, so the run "just stops" and only a later startup
 * orphan-reconcile marks it failed — with no clue whether it was OOM, disk, or a
 * deploy. Disk pressure was already surfaced; memory was not. This samples the
 * container's memory limit + usage on a short interval, drops a breadcrumb every
 * tick (so any later event carries the fill level), and captures a warning/error
 * as usage crosses thresholds — but only on *escalation*, so a sustained-high
 * state doesn't flood the reporter.
 */

export type MemoryPressureLevel = 'ok' | 'warning' | 'critical'
export const MEMORY_WARNING_FRACTION = 0.8
export const MEMORY_CRITICAL_FRACTION = 0.9

/** Sample interval. Short (unlike the 10-min disk sweep) so a fast memory climb
 *  is caught close to the OOM rather than missed between samples. */
export const MEMORY_SAMPLE_INTERVAL_MS = (() => {
  const n = Number(process.env.CONDUIT_MEMORY_SAMPLE_INTERVAL_MS)
  return Number.isFinite(n) && n > 0 ? n : 60_000 // 60s
})()

/** Bucket a used-memory fraction (0–1) into an alerting level. */
export function classifyMemoryUsage(usedFraction: number): MemoryPressureLevel {
  if (usedFraction >= MEMORY_CRITICAL_FRACTION) return 'critical'
  if (usedFraction >= MEMORY_WARNING_FRACTION) return 'warning'
  return 'ok'
}

/** used / limit, clamped to [0,1]; 0 for a missing/zero/unlimited limit (never NaN/∞). */
export function memoryFraction(usedBytes: number, limitBytes: number): number {
  if (!(limitBytes > 0)) return 0
  return Math.min(1, Math.max(0, usedBytes / limitBytes))
}

const LEVEL_RANK: Record<MemoryPressureLevel, number> = { ok: 0, warning: 1, critical: 2 }
/** Alert only when pressure rises to a higher level — prevents a per-tick flood
 *  while a run sits above a threshold for minutes. Returning to a lower level
 *  re-arms the next escalation. */
export function shouldEscalate(prev: MemoryPressureLevel, next: MemoryPressureLevel): boolean {
  return LEVEL_RANK[next] > LEVEL_RANK[prev]
}

export interface MemoryPressure {
  limitBytes: number
  usedBytes: number
  usedFraction: number
  source: 'cgroup-v2' | 'cgroup-v1' | 'os'
  /** Reclaimable page cache excluded from `usedBytes`, when the cgroup reported it. */
  pageCacheBytes?: number
}

function readNum(path: string): number | null {
  try {
    const n = Number(fs.readFileSync(path, 'utf8').trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** Parse a numeric field from cgroup memory.stat content (`key value` lines). */
export function parseMemoryStat(content: string, key: string): number | null {
  for (const line of content.split('\n')) {
    const [k, v] = line.trim().split(/\s+/)
    if (k === key) {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
  }
  return null
}

function readStatField(path: string, key: string): number | null {
  try {
    return parseMemoryStat(fs.readFileSync(path, 'utf8'), key)
  } catch {
    return null
  }
}

/**
 * The OOM killer charges reclaimable page cache against the cgroup, but the
 * kernel frees it under pressure before killing anything — so raw
 * `memory.current` permanently pins at ~100% on a host that reads gigabytes of
 * git data through the page cache, a false positive (CONDUIT-E). Kubernetes'
 * own working-set formula is `current - inactive_file`; match it. Without stat
 * data, fall back to the raw current rather than disabling the monitor.
 */
export function workingSetBytes(currentBytes: number, pageCacheBytes: number | null): number {
  if (pageCacheBytes == null) return currentBytes
  return Math.max(0, currentBytes - pageCacheBytes)
}

/**
 * Real memory usage of the container/host, preferring the cgroup limit (the
 * number the OOM killer actually enforces) over host totals. Usage is the
 * working set — raw usage minus reclaimable page cache (see {@link
 * workingSetBytes}). cgroup v2 first
 * (`memory.max` / `memory.current`), then v1
 * (`memory.limit_in_bytes` / `memory.usage_in_bytes`), then the OS as a fallback.
 * A cgroup limit of `max` / an unset sentinel (larger than host RAM) means
 * "unlimited" → fall through so we don't report a meaningless ~0% against a
 * astronomically large limit. Never throws.
 */
export async function measureMemoryPressure(): Promise<MemoryPressure> {
  const hostTotal = os.totalmem()
  // A cgroup "limit" at/above this is effectively unlimited (v1 uses a ~2^63
  // sentinel; an unconstrained v2 reports "max", parsed as NaN → skipped).
  const isRealLimit = (limit: number | null): limit is number =>
    limit != null && limit > 0 && limit < hostTotal * 2

  // cgroup v2
  const v2Max = readNum('/sys/fs/cgroup/memory.max')
  const v2Cur = readNum('/sys/fs/cgroup/memory.current')
  if (isRealLimit(v2Max) && v2Cur != null) {
    const cache = readStatField('/sys/fs/cgroup/memory.stat', 'inactive_file')
    const used = workingSetBytes(v2Cur, cache)
    return { limitBytes: v2Max, usedBytes: used, usedFraction: memoryFraction(used, v2Max), source: 'cgroup-v2', pageCacheBytes: cache ?? undefined }
  }

  // cgroup v1
  const v1Max = readNum('/sys/fs/cgroup/memory/memory.limit_in_bytes')
  const v1Cur = readNum('/sys/fs/cgroup/memory/memory.usage_in_bytes')
  if (isRealLimit(v1Max) && v1Cur != null) {
    const cache = readStatField('/sys/fs/cgroup/memory/memory.stat', 'total_inactive_file')
    const used = workingSetBytes(v1Cur, cache)
    return { limitBytes: v1Max, usedBytes: used, usedFraction: memoryFraction(used, v1Max), source: 'cgroup-v1', pageCacheBytes: cache ?? undefined }
  }

  // OS fallback (host RAM) — less accurate under a cgroup limit, but always available.
  const used = hostTotal - os.freemem()
  return { limitBytes: hostTotal, usedBytes: used, usedFraction: memoryFraction(used, hostTotal), source: 'os' }
}

let lastLevel: MemoryPressureLevel = 'ok'

/**
 * Sample memory and emit telemetry: always a breadcrumb (so any later event
 * carries the fill level), plus a warning/error `captureMessage` when usage
 * escalates past {@link MEMORY_WARNING_FRACTION}/{@link MEMORY_CRITICAL_FRACTION}.
 * Fire-and-forget; never throws.
 */
export async function reportMemoryPressure(): Promise<MemoryPressure | null> {
  let pressure: MemoryPressure
  try {
    pressure = await measureMemoryPressure()
  } catch (err) {
    reporter.captureException(err, { tags: { component: 'memoryPressure', op: 'measure' } })
    return null
  }
  const level = classifyMemoryUsage(pressure.usedFraction)
  const pct = Math.round(pressure.usedFraction * 100)
  const usedMb = Math.round(pressure.usedBytes / (1024 * 1024))
  const limitMb = Math.round(pressure.limitBytes / (1024 * 1024))
  reporter.addBreadcrumb({
    category: 'memory',
    message: `memory ${pct}% used (${usedMb} MB / ${limitMb} MB, ${pressure.source})`,
    level: level === 'critical' ? 'error' : level === 'warning' ? 'warning' : 'info',
    data: { ...pressure, level },
  })
  if (shouldEscalate(lastLevel, level)) {
    reporter.captureMessage(
      `Conduit memory ${pct}% of its limit (${usedMb} MB / ${limitMb} MB) — a run will be ` +
        `OOM-killed (taking the whole process down mid-run) as it fills.`,
      level === 'critical' ? 'error' : 'warning',
      { tags: { component: 'memoryPressure', op: 'pressure', level, source: pressure.source }, extra: { ...pressure } }
    )
  }
  lastLevel = level
  return pressure
}

/**
 * Start sampling memory pressure on {@link MEMORY_SAMPLE_INTERVAL_MS}. Returns a
 * stop function. The interval is `unref`'d so it never keeps the process alive.
 */
export function startMemoryMonitor(intervalMs: number = MEMORY_SAMPLE_INTERVAL_MS): () => void {
  void reportMemoryPressure()
  const id = setInterval(() => void reportMemoryPressure(), intervalMs)
  if (typeof id.unref === 'function') id.unref()
  return () => clearInterval(id)
}
