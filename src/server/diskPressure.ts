import * as fs from 'fs'
import { diskFullMessage } from './gitOps'

/**
 * Shared data-volume fill helpers. Kept free of the runner/sweeper graph so
 * workers can refuse to start a run when the volume is already critically full
 * without creating an import cycle.
 */

export type DiskPressureLevel = 'ok' | 'warning' | 'critical'
export const DISK_WARNING_FRACTION = 0.8
export const DISK_CRITICAL_FRACTION = 0.9

/** Bucket a used-space fraction (0–1) into an alerting level. */
export function classifyDiskUsage(usedFraction: number): DiskPressureLevel {
  if (usedFraction >= DISK_CRITICAL_FRACTION) return 'critical'
  if (usedFraction >= DISK_WARNING_FRACTION) return 'warning'
  return 'ok'
}

export interface DiskPressure {
  totalBytes: number
  freeBytes: number
  usedFraction: number
}

/**
 * Real filesystem usage of the volume backing `dir`, via `statfs`. `freeBytes`
 * uses blocks available to an unprivileged user. Never returns a fraction
 * outside [0, 1].
 */
export async function measureDiskPressure(dir: string): Promise<DiskPressure> {
  const st = await fs.promises.statfs(dir)
  const totalBytes = st.bsize * st.blocks
  const freeBytes = st.bsize * st.bavail
  const usedFraction =
    totalBytes > 0 ? Math.min(1, Math.max(0, (totalBytes - freeBytes) / totalBytes)) : 0
  return { totalBytes, freeBytes, usedFraction }
}

/**
 * Throw an operator-facing disk-full error when `dir`'s volume is at/above
 * {@link DISK_CRITICAL_FRACTION}. A measurement failure is ignored — we must
 * not block runs because `statfs` is unavailable.
 */
export async function assertVolumeHasSpace(dir: string, action: string): Promise<void> {
  let pressure: DiskPressure
  try {
    pressure = await measureDiskPressure(dir)
  } catch {
    return
  }
  if (classifyDiskUsage(pressure.usedFraction) === 'critical') {
    throw new Error(diskFullMessage(action))
  }
}
