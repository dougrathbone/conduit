import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Configurable git spawn mock. Tests flip a flag to fail a specific subcommand.
// `git clone` simulates git creating its destination directory even on failure —
// that partial directory is exactly what we assert gets cleaned up.
const spawnCalls: string[][] = []
const gitMock = { cloneFails: false, lsRemoteFails: false, configFails: false }

vi.mock('child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[]) => {
    spawnCalls.push(args)
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      const sub = args[0]
      if (sub === 'clone') {
        // git creates the destination dir even for a clone that then fails auth.
        const dest = args[args.length - 1]
        const authUrl = args[args.length - 2]
        fs.mkdirSync(dest, { recursive: true })
        fs.writeFileSync(path.join(dest, 'HEAD'), 'ref: refs/heads/main\n')
        if (gitMock.cloneFails) {
          child.stderr.emit('data', Buffer.from(`remote: Invalid username or password.\nfatal: Authentication failed for '${authUrl}'\n`))
          child.emit('close', 128)
        } else {
          child.emit('close', 0)
        }
        return
      }
      if (sub === 'ls-remote' && gitMock.lsRemoteFails) {
        child.stderr.emit('data', Buffer.from(`fatal: Authentication failed for '${args[args.length - 1]}'\n`))
        child.emit('close', 128)
        return
      }
      if (sub === 'config' && gitMock.configFails) {
        child.stderr.emit('data', Buffer.from('error: could not lock config file .git/config: File exists\n'))
        child.emit('close', 1)
        return
      }
      child.emit('close', 0)
    })
    return child
  }),
}))

import { cloneRepo, testRepoConnection, createConfiguredWorktree } from './gitOps'

let base: string
beforeEach(() => {
  spawnCalls.length = 0
  gitMock.cloneFails = false
  gitMock.lsRemoteFails = false
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-clone-test-'))
})

describe('cloneRepo credential-failure handling', () => {
  it('removes the partial clone directory when the clone fails on bad credentials', async () => {
    gitMock.cloneFails = true
    const clonePath = path.join(base, 'repo-a')
    await expect(cloneRepo('https://github.com/acme/w.git', clonePath, 'main', 'ghs_bad')).rejects.toThrow()
    // A failed clone must leave nothing behind — neither at the final path nor a
    // temp path — or it leaks disk and traps the sync loop into fetching an invalid repo.
    expect(fs.existsSync(clonePath)).toBe(false)
    expect(fs.existsSync(`${clonePath}.cloning`)).toBe(false)
  })

  it('publishes a fully-cloned repo to the final path on success', async () => {
    const clonePath = path.join(base, 'repo-b')
    await cloneRepo('https://github.com/acme/w.git', clonePath, 'main', 'ghs_ok')
    expect(fs.existsSync(path.join(clonePath, 'HEAD'))).toBe(true)
    expect(fs.existsSync(`${clonePath}.cloning`)).toBe(false)
  })

  it('redacts the token from the clone failure message', async () => {
    gitMock.cloneFails = true
    const clonePath = path.join(base, 'repo-c')
    const err = (await cloneRepo('https://github.com/acme/w.git', clonePath, 'main', 'ghs_supersecret').catch((e) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain('ghs_supersecret')
  })
})

describe('createConfiguredWorktree (the run execute phase)', () => {
  it('removes the worktree if git configuration fails after the worktree was created', async () => {
    gitMock.configFails = true
    const clonePath = path.join(base, 'bare')
    fs.mkdirSync(clonePath, { recursive: true })
    const worktree = path.join(clonePath, 'worktrees-run', 'r1')
    await expect(
      createConfiguredWorktree(clonePath, worktree, 'main', {
        url: 'https://github.com/acme/w.git',
        token: 'ghs_x',
        authorName: 'Conduit',
        authorEmail: 'conduit@example.com',
      })
    ).rejects.toThrow()
    // The worktree was added, then torn down when configuration failed — never
    // left behind to leak disk and be reclaimed only by the slow sweeper.
    const subs = spawnCalls.map((a) => `${a[0]} ${a[1]}`)
    expect(subs).toContain('worktree add')
    expect(subs.some((s) => s === 'worktree remove' || s === 'worktree prune')).toBe(true)
  })
})

describe('testRepoConnection (the credential test phase)', () => {
  it('rejects with a redacted message when credentials are bad', async () => {
    gitMock.lsRemoteFails = true
    const err = (await testRepoConnection('https://github.com/acme/w.git', 'ghs_secret').catch((e) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain('ghs_secret')
  })

  it('reports connectivity on success', async () => {
    const msg = await testRepoConnection('https://github.com/acme/w.git', 'ghs_ok')
    expect(msg).toMatch(/Connected/)
  })
})
