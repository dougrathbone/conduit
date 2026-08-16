/**
 * Container process mode — server (orchestrator) vs worker.
 * Task 2 implements parsing and the mode-aware entrypoint.
 */
export type ConduitProcessMode = 'server' | 'worker'

/** Stub: always server so contracts compile. Task 2 honors CONDUIT_PROCESS_MODE. */
export function resolveProcessMode(_env: NodeJS.ProcessEnv = process.env): ConduitProcessMode {
  return 'server'
}
