import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { writeClaudeConfig, deleteClaudeConfig } from './claudeConfig'

const RUN_ID = 'test-claudecfg-1111'

afterEach(() => {
  deleteClaudeConfig(RUN_ID)
})

describe('writeClaudeConfig', () => {
  it('writes .claude.json pre-trusting each path', () => {
    const dir = writeClaudeConfig(RUN_ID, [
      '/data/repos/abc',
      '/data/repos/abc/worktrees-run/xyz',
    ])
    const json = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'))
    expect(json.projects['/data/repos/abc'].hasTrustDialogAccepted).toBe(true)
    expect(json.projects['/data/repos/abc/worktrees-run/xyz'].hasTrustDialogAccepted).toBe(true)
  })

  it('ignores empty/falsy paths', () => {
    const dir = writeClaudeConfig(RUN_ID, ['/ws', '', undefined as unknown as string])
    const json = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'))
    expect(Object.keys(json.projects)).toEqual(['/ws'])
  })

  it('deleteClaudeConfig removes the dir and is safe to call twice', () => {
    const dir = writeClaudeConfig(RUN_ID, ['/ws'])
    expect(fs.existsSync(dir)).toBe(true)
    deleteClaudeConfig(RUN_ID)
    expect(fs.existsSync(dir)).toBe(false)
    expect(() => deleteClaudeConfig(RUN_ID)).not.toThrow()
  })
})
