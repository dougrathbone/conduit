/**
 * Background-task timeout resolution for runner processes.
 *
 * Some agent CLIs cap how long they wait for spawned background tasks before
 * terminating them. Claude Code does this via `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`
 * (default 600000ms); setting it to `0` waits indefinitely. Conduit lets users
 * configure this per provider (Settings) and per agent (AgentEditor), defaulting
 * to `0` so runs are not cut off mid-background-task.
 *
 * Kept as a standalone, dependency-free module so the precedence + unit-conversion
 * logic is unit-testable without pulling in the runner's process/DB graph.
 */

/**
 * Env var each runner reads its background-task wait ceiling from. Only Claude
 * Code exposes one today; Amp and cursor-agent have no known equivalent, so a
 * configured value is stored but injects nothing (a documented no-op) until a
 * var name is known.
 */
export const RUNNER_TIMEOUT_ENV_VAR: Record<string, string | undefined> = {
  claude: 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS',
}

function isValidTimeout(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

/**
 * Effective background-task timeout in **seconds**. Precedence: the agent's own
 * override, then the user's per-provider setting, then the built-in default of
 * `0` (run indefinitely). An explicit `0` at any level is a valid, winning value
 * (indefinite); negative / non-finite values are ignored and fall through.
 */
export function resolveBgTaskTimeoutSeconds(
  agentSeconds: number | null | undefined,
  userSeconds: number | null | undefined
): number {
  if (isValidTimeout(agentSeconds)) return agentSeconds
  if (isValidTimeout(userSeconds)) return userSeconds
  return 0
}

/**
 * The env entry to inject for a runner's background-task timeout, or `{}` when
 * the runner has no such knob or the agent already set the var by hand (a manual
 * `envVars` entry always wins). The stored value is seconds; the env var is
 * milliseconds.
 */
export function bgTaskTimeoutEnvEntry(
  runner: string,
  effectiveSeconds: number,
  existingEnvVars?: Record<string, string>
): Record<string, string> {
  const envVar = RUNNER_TIMEOUT_ENV_VAR[runner]
  if (!envVar) return {}
  if (existingEnvVars && envVar in existingEnvVars) return {}
  return { [envVar]: String(effectiveSeconds * 1000) }
}
