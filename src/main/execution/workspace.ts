import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/**
 * Creates an ephemeral workspace directory for a run.
 * Returns the path to the created directory.
 */
export function createWorkspace(runId: string): string {
  const prefix = path.join(os.tmpdir(), `conduit-${runId}-`)
  return fs.mkdtempSync(prefix)
}

/**
 * Deletes a workspace directory recursively. Swallows all errors.
 */
export function deleteWorkspace(workspacePath: string): void {
  try {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  } catch {
    // Ignore — workspace may have already been removed
  }
}
