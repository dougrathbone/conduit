/**
 * Per-run MCP config file management — filesystem only, no DB/OAuth imports,
 * so the standalone conduit-worker process can use it without pulling in the
 * server's data layer. The filename embeds the runId so data-dir sweepers on
 * either side can recognize and reap leftover files.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

function mcpConfigPath(runId: string): string {
  return path.join(os.tmpdir(), `conduit-mcp-${runId}.json`)
}

/**
 * Write pre-materialized MCP config content to the run's config file and
 * return its path. Content comes from the orchestrator (merged global servers,
 * OAuth tokens injected, env vars expanded) — directly for in-process runs, or
 * inside the RunSpec for remote workers.
 */
export function writeMcpConfigContent(runId: string, content: string): string {
  const filePath = mcpConfigPath(runId)
  fs.writeFileSync(filePath, content, 'utf8')
  return filePath
}

export function deleteMcpConfig(runId: string): void {
  try {
    fs.unlinkSync(mcpConfigPath(runId))
  } catch {
    // Ignore — file may have already been deleted or never created
  }
}
