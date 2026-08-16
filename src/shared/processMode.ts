/**
 * Container process mode — server (orchestrator) vs worker.
 * The image entrypoint (`scripts/container-entrypoint.sh`) honors the same
 * `CONDUIT_PROCESS_MODE=server|worker` contract (default server, fail closed).
 */
export type ConduitProcessMode = 'server' | 'worker'

export function resolveProcessMode(env: NodeJS.ProcessEnv = process.env): ConduitProcessMode {
  const raw = env.CONDUIT_PROCESS_MODE
  const normalized = raw?.trim().toLowerCase() ?? ''
  if (!normalized) return 'server'
  if (normalized === 'server' || normalized === 'worker') return normalized
  throw new Error(`CONDUIT_PROCESS_MODE must be "server" or "worker" (got "${raw}")`)
}
