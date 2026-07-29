import { createAppAuth } from '@octokit/auth-app'
import { getGithubPat } from './store'
import { decryptSecret } from './crypto'
import { getRepositoryCredentials } from '../main/db/queries/repositories'
import type { Repository } from '../shared/types'

const GITHUB_API = 'https://api.github.com'

const RETRY_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 1000 // 1s, 2s between attempts (+ jitter)

/** errno-style codes from DNS/socket failures that are worth retrying. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

/** An HTTP error response from the GitHub API, carrying its status code. */
class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'GithubApiError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * True when a GitHub API failure is transient and safe to retry:
 * - 5xx responses (GitHub-side errors)
 * - GitHub's edge-timeout message ("couldn't respond to your request in time"),
 *   which can surface with any status code
 * - network-level failures: undici's `TypeError: fetch failed`, errno-style
 *   codes, and octokit RequestErrors with no status (socket gave up)
 *
 * 4xx means auth/config (bad credentials, installation not found) — fail fast.
 */
export function isTransientGithubError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (/couldn't respond to your request in time/i.test(err.message)) return true
  const status = (err as { status?: unknown }).status
  if (typeof status === 'number') return status >= 500
  if (err instanceof TypeError) return true
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)
}

/**
 * Run an idempotent GitHub API call with bounded exponential backoff.
 * Only transient failures (see `isTransientGithubError`) are retried; 4xx and
 * programming errors propagate immediately. The final failure is rethrown as-is.
 */
export async function withTransientGithubRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const attempts = opts.attempts ?? RETRY_ATTEMPTS
  const baseDelayMs = opts.baseDelayMs ?? RETRY_BASE_DELAY_MS
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= attempts || !isTransientGithubError(err)) throw err
      const backoff = baseDelayMs * 2 ** (attempt - 1)
      // Jitter (0–50% of the backoff) keeps concurrent repo syncs from
      // retrying GitHub in lockstep after a shared blip.
      await sleep(backoff + Math.random() * backoff * 0.5)
    }
  }
}

/**
 * Extract `owner` and `repo` from a GitHub clone URL. Handles HTTPS (with or
 * without embedded credentials / `.git` suffix) and `git@host:owner/repo` SSH form.
 */
export function parseGithubOwnerRepo(url: string): { owner: string; repo: string } {
  let s = url.trim()
  // scp-style SSH (`git@host:owner/repo`) only — guard against HTTPS URLs that
  // carry userinfo and a port (`https://user@host:8443/owner/repo`) matching too.
  const sshMatch = s.includes('://') ? null : s.match(/^[^@]+@[^:]+:(.+)$/)
  if (sshMatch) {
    s = sshMatch[1]
  } else {
    s = s.replace(/^https?:\/\//, '') // strip scheme
    s = s.replace(/^[^@/]+@/, '') // strip embedded credentials
    const slash = s.indexOf('/')
    if (slash !== -1) s = s.slice(slash + 1) // drop host
  }
  s = s.replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = s.split('/').filter(Boolean)
  if (parts.length < 2) {
    throw new Error(`Cannot parse owner/repo from URL: ${url}`)
  }
  return { owner: parts[0], repo: parts[1] }
}

/**
 * Mint a short-lived (~1h) GitHub App installation access token for a repo.
 *
 * 1. Sign an app JWT from the App ID + private key.
 * 2. Auto-discover the installation that covers the repo's owner/repo.
 * 3. Mint an installation access token for that installation.
 *
 * Steps 2–3 are retried with backoff on transient GitHub failures (5xx,
 * network timeouts); 4xx auth/config errors fail fast.
 */
export async function mintInstallationToken(opts: {
  appId: string
  privateKey: string
  repoUrl: string
}): Promise<string> {
  const { appId, privateKey, repoUrl } = opts
  const { owner, repo } = parseGithubOwnerRepo(repoUrl)
  const auth = createAppAuth({ appId, privateKey })

  // App JWT for installation discovery.
  const appAuth = await auth({ type: 'app' })

  // Both API calls below are idempotent, and GitHub intermittently answers
  // with transient 5xx / "couldn't respond in time" errors — retry those
  // briefly instead of failing the whole repo sync on a single blip.
  const installation = await withTransientGithubRetry(async () => {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/installation`, {
      headers: {
        Authorization: `Bearer ${appAuth.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'conduit',
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const message =
        res.status >= 500
          ? `GitHub API error discovering the GitHub App installation for ${owner}/${repo} ` +
            `(HTTP ${res.status}). ${body}`
          : `GitHub App (id ${appId}) is not installed for ${owner}/${repo} ` +
            `(HTTP ${res.status}). Install the app and grant it repo access. ${body}`
      throw new GithubApiError(message.trim(), res.status)
    }
    const installation = (await res.json()) as { id?: number }
    if (typeof installation?.id !== 'number') {
      throw new Error(
        `Unexpected response discovering the GitHub App installation for ${owner}/${repo}.`
      )
    }
    return installation
  })

  const installationAuth = await withTransientGithubRetry(() =>
    auth({ type: 'installation', installationId: installation.id })
  )
  return installationAuth.token
}

/**
 * Resolve the git credential token for a repository based on its auth method:
 * - `pat`        → the global GitHub PAT from the environment
 * - `githubapp`  → decrypt the stored key and mint an installation token
 * - `ssh`/`none` → no token (handled outside HTTPS token injection)
 */
export async function resolveRepoToken(
  repo: Pick<Repository, 'id' | 'url' | 'authMethod'>
): Promise<string | undefined> {
  switch (repo.authMethod) {
    case 'pat':
      return getGithubPat()
    case 'githubapp': {
      const creds = await getRepositoryCredentials(repo.id)
      if (!creds?.githubAppId || !creds.githubPrivateKeyEnc) {
        throw new Error(
          `Repository ${repo.id} uses GitHub App auth but is missing an App ID or private key.`
        )
      }
      const privateKey = decryptSecret(creds.githubPrivateKeyEnc)
      return mintInstallationToken({ appId: creds.githubAppId, privateKey, repoUrl: repo.url })
    }
    case 'ssh':
    case 'none':
    default:
      return undefined
  }
}

/**
 * Env var the GitHub CLI (`gh`) reads its auth token from. `gh` does NOT pick up
 * the tokenized `origin` URL that `git push` uses, so its token must be handed to
 * the agent process explicitly. `GH_TOKEN` takes precedence over `GITHUB_TOKEN`
 * in `gh`, and — unlike `GITHUB_TOKEN` — is `gh`-specific, so it won't shadow a
 * token an agent/script manages itself.
 */
export const GH_TOKEN_ENV_VAR = 'GH_TOKEN'

/**
 * Shape the `GH_TOKEN` env entry for a run, mirroring the API-key/timeout
 * injection rules in the runner:
 * - no token resolved (ssh/none repos, repo-less runs) → set nothing;
 * - an explicit per-agent `GH_TOKEN` in `existingEnvVars` always wins → set nothing;
 * - otherwise expose the resolved repo credential as `GH_TOKEN` so `gh api` /
 *   `gh pr create` authenticate as the same identity that `git push` uses.
 */
export function githubTokenEnvEntry(
  token: string | undefined,
  existingEnvVars?: Record<string, string>
): Record<string, string> {
  if (!token) return {}
  if (existingEnvVars && GH_TOKEN_ENV_VAR in existingEnvVars) return {}
  return { [GH_TOKEN_ENV_VAR]: token }
}

export interface PushCredential {
  /** The resolved git token, or undefined for ssh/none (or on failure). */
  token?: string
  /** Set when token resolution threw — the reason `git push` will fail. */
  error?: Error
}

/**
 * Resolve a repository's git push token WITHOUT throwing.
 *
 * A run should still start when a credential can't be minted — the agent can do
 * useful read-only work — but the failure must NOT be swallowed silently. A
 * missing token makes the agent's later `git push` fail with an opaque
 * credential error ("could not read Username", "terminal prompts disabled") and
 * no breadcrumb pointing at Conduit's token resolution. The caller is expected
 * to surface `error` into the run log and the error reporter.
 */
export async function resolvePushCredential(
  repo: Pick<Repository, 'id' | 'url' | 'authMethod'>
): Promise<PushCredential> {
  try {
    return { token: await resolveRepoToken(repo) }
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) }
  }
}
