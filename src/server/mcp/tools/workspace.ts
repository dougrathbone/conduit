import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listAgents } from '../../../main/db/queries/agents'
import { listRecentRuns } from '../../../main/db/queries/runs'
import { getRepository, listRepositories } from '../../../main/db/queries/repositories'
import { listPublishTargets } from '../../../main/db/queries/publishTargets'
import { listGlobalMcps } from '../../../main/db/queries/globalMcps'
import { getCredentialStatus } from '../../../main/db/queries/agentCredentials'
import { getUser } from '../../../main/db/queries/users'
import { canAccessEntity } from '../../../main/db/queries/access'
import { isAuthEnabled } from '../../auth/config'
import { ClientError } from '../../errors'
import { checkRunnerClis } from '../../runnerCli'
import { redactGlobalMcp, redactPublishTarget, redactUrl } from '../redact'
import { registerTool, type ToolEnv } from '../registry'
import { failureKind, summarizeRun } from './runs'
import type { Repository } from '../../../shared/types'

function presentRepository(repo: Repository) {
  return {
    id: repo.id,
    name: repo.name,
    url: redactUrl(repo.url),
    defaultBranch: repo.defaultBranch,
    authMethod: repo.authMethod,
    syncStatus: repo.syncStatus,
    syncError: repo.syncError,
    lastSyncedAt: repo.lastSyncedAt ? new Date(repo.lastSyncedAt).toISOString() : undefined,
    githubAppId: repo.githubAppId,
    hasGithubKey: repo.hasGithubKey,
  }
}

export function registerWorkspaceTools(server: McpServer, env: ToolEnv): void {
  registerTool(server, env, {
    name: 'get_conduit_status',
    title: 'Conduit status overview',
    description:
      'Start here when investigating. Who you are and your token scope, the auth mode, the worker factory and connected workers, which runner CLIs are installed, which runner credentials you have stored, runs in progress, failures in the last 24h, and repositories with sync errors.',
    access: 'read',
    input: {},
    run: async (_args, { caller, deps }) => {
      const agents = await listAgents(caller.userId, caller.userGroupIds)
      const agentIds = agents.map((a) => a.id)
      const names = new Map(agents.map((a) => [a.id, a.name]))
      const [user, clis, credentials, running, failed, repos] = await Promise.all([
        getUser(caller.userId),
        checkRunnerClis(),
        getCredentialStatus(caller.userId),
        listRecentRuns({ agentIds, status: 'running', limit: 50 }),
        listRecentRuns({ agentIds, status: 'failed', since: Date.now() - 86_400_000, limit: 50 }),
        listRepositories(caller.userId, caller.userGroupIds),
      ])
      const failuresByKind: Record<string, number> = {}
      for (const run of failed) {
        const kind = failureKind(run) ?? 'unknown'
        failuresByKind[kind] = (failuresByKind[kind] ?? 0) + 1
      }
      return {
        caller: {
          userId: caller.userId,
          name: user?.name,
          email: user?.email,
          scope: caller.scope,
          auth: caller.authKind,
          tokenName: caller.tokenName,
        },
        authMode: isAuthEnabled() ? 'okta' : 'dev-bypass',
        workers: deps.workerStatus(),
        runnerClis: clis,
        storedCredentials: credentials,
        visibleAgents: agents.length,
        runsInProgress: running.map((r) => ({ ...summarizeRun(r), agentName: names.get(r.agentId) })),
        failuresLast24h: {
          total: failed.length,
          byKind: failuresByKind,
          recent: failed.slice(0, 10).map((r) => ({
            ...summarizeRun(r),
            agentName: names.get(r.agentId),
            failureKind: failureKind(r),
          })),
        },
        repositoriesWithErrors: repos.filter((r) => r.syncStatus === 'error').map(presentRepository),
      }
    },
  })

  registerTool(server, env, {
    name: 'list_repositories',
    title: 'List repositories',
    description: 'Managed git repositories visible to you, with sync status. Use the id as an agent repositoryId.',
    access: 'read',
    input: {},
    run: async (_args, { caller }) =>
      (await listRepositories(caller.userId, caller.userGroupIds)).map(presentRepository),
  })

  registerTool(server, env, {
    name: 'sync_repository',
    title: 'Sync repository',
    description: "Fetch a managed repository's latest commits now (clones it if it was never cloned).",
    access: 'write',
    idempotent: true,
    input: { repositoryId: z.string() },
    run: async ({ repositoryId }, { caller, deps }) => {
      const repo = await getRepository(repositoryId)
      if (!repo || !(await canAccessEntity('repository', repositoryId, caller.userId, caller.userGroupIds))) {
        throw new ClientError(`Repository "${repositoryId}" was not found or is not accessible to you.`)
      }
      await deps.triggerRepoSync(repositoryId)
      const after = await getRepository(repositoryId)
      return presentRepository(after ?? repo)
    },
  })

  registerTool(server, env, {
    name: 'list_publish_targets',
    title: 'List publish targets',
    description:
      'Publish targets (Slack, email, webhook) visible to you. Attach them to agents via update_agent publishTargetIds. Secrets are redacted.',
    access: 'read',
    input: {},
    run: async (_args, { caller }) =>
      (await listPublishTargets(caller.userId, caller.userGroupIds)).map(redactPublishTarget),
  })

  registerTool(server, env, {
    name: 'list_global_mcp_servers',
    title: 'List global MCP servers',
    description:
      'Global MCP servers, loaded into every run when enabled. Their keys cannot be reused by agent MCP servers. Secrets are redacted.',
    access: 'read',
    input: {},
    run: async (_args, { caller }) =>
      (await listGlobalMcps(caller.userId, caller.userGroupIds)).map(redactGlobalMcp),
  })
}
