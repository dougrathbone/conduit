/**
 * One-shot worker lifecycle — accept a single assigned run, then exit.
 * Honors `CONDUIT_WORKER_ONE_SHOT` (true/1/yes). Unset/false keeps the
 * reconnecting pooled behavior used by remote workers.
 */
export type WorkerDisconnectPlan = 'reconnect' | 'exit'
export type WorkerRunEndPlan = 'idle' | 'exit'

export function isWorkerOneShot(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CONDUIT_WORKER_ONE_SHOT?.trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes'
}

export function planAfterDisconnect(env: NodeJS.ProcessEnv = process.env): WorkerDisconnectPlan {
  return isWorkerOneShot(env) ? 'exit' : 'reconnect'
}

export function planAfterRunExit(env: NodeJS.ProcessEnv = process.env): WorkerRunEndPlan {
  return isWorkerOneShot(env) ? 'exit' : 'idle'
}
