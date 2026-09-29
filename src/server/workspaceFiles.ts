import * as fs from 'fs'
import * as path from 'path'
import { normalizeWorkspaceRelativePath } from '../shared/promptComponents'

/**
 * Write Conduit-wide files into a materialized workspace. Parent directories
 * are created as needed. If the target already exists, the Conduit content is
 * prepended so a repo's own file is not discarded.
 */
export function writeWorkspaceFiles(
  workspaceRoot: string,
  files: { path: string; content: string; name: string }[]
): void {
  const root = path.resolve(workspaceRoot)
  for (const file of files) {
    const relative = normalizeWorkspaceRelativePath(file.path)
    const dest = path.resolve(root, relative)
    const relativeToRoot = path.relative(root, dest)
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Refusing to write workspace file outside the workspace: ${file.path}`)
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const banner = [
      `===== BEGIN CONDUIT-WIDE FILE: ${file.name} =====`,
      file.content,
      `===== END CONDUIT-WIDE FILE: ${file.name} =====`,
      '',
    ].join('\n')
    if (fs.existsSync(dest)) {
      const existing = fs.readFileSync(dest, 'utf8')
      fs.writeFileSync(dest, `${banner}${existing}`, 'utf8')
    } else {
      fs.writeFileSync(dest, file.content.endsWith('\n') ? file.content : `${file.content}\n`, 'utf8')
    }
  }
}
