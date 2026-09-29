import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeWorkspaceFiles } from './workspaceFiles'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-ws-'))
  dirs.push(d)
  return d
}

describe('writeWorkspaceFiles', () => {
  it('writes nested relative files', () => {
    const root = tmp()
    writeWorkspaceFiles(root, [{ path: '.cursor/rules/org.mdc', content: 'always apply', name: 'Org rules' }])
    expect(fs.readFileSync(path.join(root, '.cursor/rules/org.mdc'), 'utf8')).toBe('always apply\n')
  })

  it('prepends when the file already exists', () => {
    const root = tmp()
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'from the repo\n')
    writeWorkspaceFiles(root, [{ path: 'CLAUDE.md', content: 'from conduit', name: 'Global CLAUDE.md' }])
    const out = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')
    expect(out).toContain('BEGIN CONDUIT-WIDE FILE: Global CLAUDE.md')
    expect(out).toContain('from conduit')
    expect(out.endsWith('from the repo\n')).toBe(true)
  })

  it('refuses paths that escape the workspace', () => {
    const root = tmp()
    expect(() =>
      writeWorkspaceFiles(root, [{ path: '../escape.md', content: 'nope', name: 'x' }])
    ).toThrow(/"\.\."/)
  })
})
