/**
 * One-shot worker lifecycle — accept a single assigned run, then exit.
 * Task 2 implements CONDUIT_WORKER_ONE_SHOT and wires it into the worker loop.
 */
export type WorkerDisconnectPlan = 'reconnect' | 'exit'
export type WorkerRunEndPlan = 'idle' | 'exit'

/** Stub: always pooled. Task 2 reads CONDUIT_WORKER_ONE_SHOT. */
export function isWorkerOneShot(_env: NodeJS.ProcessEnv = process.env): boolean {
  return false
}

export function planAfterDisconnect(env: NodeJS.ProcessEnv = process.env): WorkerDisconnectPlan {
  return isWorkerOneShot(env) ? 'exit' : 'reconnect'
}

export function planAfterRunExit(env: NodeJS.ProcessEnv = process.env): WorkerRunEndPlan {
  return isWorkerOneShot(env) ? 'exit' : 'idle'
}
