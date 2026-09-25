import type { GlobalPromptComponent } from './types'

const MAX_RELATIVE_PATH_LENGTH = 512

/**
 * Normalize a workspace-relative file path. Rejects absolute paths, `..`
 * traversal, empty paths, and NUL bytes so a component cannot write outside
 * the run workspace.
 */
export function normalizeWorkspaceRelativePath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/')
  if (!trimmed) {
    throw new Error('File path is required for file components.')
  }
  if (trimmed.length > MAX_RELATIVE_PATH_LENGTH) {
    throw new Error(`File path must be at most ${MAX_RELATIVE_PATH_LENGTH} characters.`)
  }
  if (trimmed.includes('\0')) {
    throw new Error('File path cannot contain a NUL byte.')
  }
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
    throw new Error('File path must be relative to the workspace (not absolute).')
  }
  const parts = trimmed.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.length === 0) {
    throw new Error('File path is required for file components.')
  }
  if (parts.some((p) => p === '..')) {
    throw new Error('File path cannot contain ".." segments.')
  }
  return parts.join('/')
}

export function validatePromptComponentInput(data: {
  name: string
  kind: string
  content?: string
  filePath?: string | null
}): { kind: 'instruction' | 'file'; filePath?: string } {
  const name = data.name.trim()
  if (!name) {
    throw new Error('Name is required.')
  }
  if (data.kind !== 'instruction' && data.kind !== 'file') {
    throw new Error('Kind must be "instruction" or "file".')
  }
  if (data.kind === 'file') {
    return { kind: 'file', filePath: normalizeWorkspaceRelativePath(data.filePath ?? '') }
  }
  return { kind: 'instruction' }
}

type PromptComponentInput = Pick<
  GlobalPromptComponent,
  'name' | 'kind' | 'content' | 'filePath' | 'enabled'
> & { createdAt?: number }

export function sortPromptComponents<T extends { createdAt?: number; name: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.name.localeCompare(b.name)
  )
}

/**
 * Prepend enabled Conduit-wide instructions and file contents to an agent prompt.
 * No-op when there are no enabled components with content.
 */
export function applyGlobalPromptComponents(
  agentPrompt: string,
  components: PromptComponentInput[]
): string {
  const enabled = sortPromptComponents(
    components.filter((c) => c.enabled && c.content.trim().length > 0)
  )
  if (enabled.length === 0) return agentPrompt

  const instructions = enabled.filter((c) => c.kind === 'instruction')
  const files = enabled.filter((c) => c.kind === 'file')

  const parts: string[] = ['# Conduit-wide instructions', '']
  parts.push(
    'These apply to every agent run in this Conduit instance. Follow them in addition to the agent prompt below.'
  )
  parts.push('')

  for (const item of instructions) {
    parts.push(`## ${item.name}`, '', item.content.trim(), '')
  }

  if (files.length > 0) {
    parts.push(
      '## Files in the workspace',
      '',
      'The following files have also been written into the run workspace (paths are relative to the working directory):',
      ''
    )
    for (const item of files) {
      const path = item.filePath ?? item.name
      parts.push(`### \`${path}\` (${item.name})`, '', '```', item.content.trim(), '```', '')
    }
  }

  parts.push('---', '', agentPrompt)
  return parts.join('\n')
}

export function workspaceFilesFromComponents(
  components: PromptComponentInput[]
): { path: string; content: string; name: string }[] {
  const files = sortPromptComponents(
    components.filter((c) => c.enabled && c.kind === 'file' && c.filePath)
  )
  return files.map((c) => ({
    path: c.filePath as string,
    content: c.content,
    name: c.name,
  }))
}
