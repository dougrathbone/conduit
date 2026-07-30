/**
 * Memory-cap resolution for runner processes.
 *
 * A run's child processes (the agent CLI plus every toolchain it spawns —
 * tsc, vite, test workers) share the pod's cgroup with Conduit itself. When
 * they exhaust it, the kernel SIGKILLs the whole container: Conduit dies with
 * the run, no close handler fires, and the run only surfaces as failed via the
 * next startup's orphan-reconcile — the "silent" run death (CONDUIT-D/E).
 *
 * Capping each Node process's heap (`--max-old-space-size` via NODE_OPTIONS,
 * which every Node child inherits) keeps individual toolchains from ballooning
 * and lowers the odds the cgroup fills. It is a per-process ceiling, not a
 * hard cgroup limit — documented as such. Non-Node children ignore NODE_OPTIONS
 * harmlessly.
 *
 * Kept as a standalone, dependency-free module so the precedence + env-merging
 * logic is unit-testable without pulling in the runner's process/DB graph.
 */

/** Server-wide default cap in MB, from `CONDUIT_RUN_MEMORY_CAP_MB` (0 = uncapped). */
export const DEFAULT_MEMORY_CAP_MB = (() => {
  const n = Number(process.env.CONDUIT_RUN_MEMORY_CAP_MB)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
})()

const MAX_OLD_SPACE_FLAG = '--max-old-space-size'

function isValidCap(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

/**
 * Effective per-process heap cap in **MB**. Precedence: the agent's own
 * override, then the server-wide default, then `0` (uncapped). An explicit `0`
 * at the agent level is a valid, winning value (uncapped) — it lets one agent
 * opt out of a server-wide cap. Negative / non-finite values fall through.
 */
export function resolveMemoryCapMb(
  agentMb: number | null | undefined,
  globalMb: number | null | undefined = DEFAULT_MEMORY_CAP_MB
): number {
  if (isValidCap(agentMb)) return agentMb
  if (isValidCap(globalMb)) return globalMb
  return 0
}

/**
 * The NODE_OPTIONS entry to inject for a run, or `{}` when uncapped or when a
 * heap cap is already in force. Merges with any NODE_OPTIONS already assembled
 * for the child (host env or the agent's own `envVars`): an explicit
 * `--max-old-space-size` there always wins; otherwise our flag is appended so
 * the operator/agent keep their other Node flags.
 */
export function memoryCapEnvEntry(
  effectiveMb: number,
  existingNodeOptions?: string
): Record<string, string> {
  if (!(effectiveMb > 0)) return {}
  const existing = existingNodeOptions?.trim() ?? ''
  if (existing.includes(MAX_OLD_SPACE_FLAG)) return {}
  return { NODE_OPTIONS: existing ? `${existing} ${MAX_OLD_SPACE_FLAG}=${effectiveMb}` : `${MAX_OLD_SPACE_FLAG}=${effectiveMb}` }
}
