/**
 * Shared config helpers for the Job/Task-per-run worker factories (EKS, Fargate).
 */

/**
 * The WebSocket URL workers dial to reach this server's control plane.
 * Explicit `CONDUIT_SERVER_URL` wins; otherwise derived from CONDUIT_BASE_URL
 * (http→ws, https→wss). Required for remote factories — there is no sensible
 * default outside localhost dev.
 */
export function resolveWorkerServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CONDUIT_SERVER_URL?.trim()
  if (explicit) return explicit
  const base = env.CONDUIT_BASE_URL?.trim()
  if (base) {
    return base.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/worker'
  }
  throw new Error(
    'CONDUIT_SERVER_URL (or CONDUIT_BASE_URL to derive it from) is required for remote ' +
      'worker factories — workers need a URL to reach this server\'s /ws/worker endpoint.'
  )
}
