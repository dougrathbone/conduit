import { safeStorage } from 'electron'

// electron-store v10 is ESM-only; use createRequire to load it in the CommonJS
// main process context that electron-vite produces.
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Store = require('electron-store')

interface StoreSchema {
  theme: 'dark' | 'light' | 'system'
  githubPatEncrypted: string | undefined
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const store = new (Store as any)({
  defaults: {
    theme: 'system',
    githubPatEncrypted: undefined,
  },
})

export function getGithubPat(): string | undefined {
  const encrypted = store.get('githubPatEncrypted') as string | undefined
  if (!encrypted) return undefined

  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = Buffer.from(encrypted, 'base64')
      return safeStorage.decryptString(buf)
    }
    // Fallback: stored as plain base64 when encryption unavailable
    return Buffer.from(encrypted, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

export function setGithubPat(pat: string): void {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(pat)
      store.set('githubPatEncrypted', encrypted.toString('base64'))
    } else {
      // Fallback: store as plain base64 when encryption unavailable (dev mode)
      store.set('githubPatEncrypted', Buffer.from(pat, 'utf8').toString('base64'))
    }
  } catch (err) {
    console.error('[store] Failed to encrypt PAT:', err)
  }
}
