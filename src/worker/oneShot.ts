/**
 * One-shot worker lifecycle — accept a single assigned run, then exit.
 * Honors `CONDUIT_WORKER_ONE_SHOT` (true/1/yes). Unset/false keeps the
 * reconnecting pooled behavior used by remote workers.
 *
 * Disconnect never abandons unacked delivery: one-shot workers reconnect
 * like pooled workers and only exit after pending reliable delivery is done.
 */
export type WorkerDisconnectPlan = 'reconnect' | 'exit'
export type WorkerRunEndPlan = 'idle' | 'exit'

export function isWorkerOneShot(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CONDUIT_WORKER_ONE_SHOT?.trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes'
}

export function planAfterDisconnect(_env: NodeJS.ProcessEnv = process.env): WorkerDisconnectPlan {
  return 'reconnect'
}

export function planAfterRunExit(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { hasPendingDelivery?: boolean }
): WorkerRunEndPlan {
  if (!isWorkerOneShot(env)) return 'idle'
  if (opts?.hasPendingDelivery) return 'idle'
  return 'exit'
}
