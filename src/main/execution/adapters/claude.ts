/**
 * Build the CLI arguments for the `claude` binary.
 * The prompt is NOT included here — it is written to stdin after spawn to avoid
 * being consumed by --mcp-config's variadic <configs...> parser.
 */
export function buildClaudeArgs(mcpConfigPath: string): string[] {
  return [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--mcp-config',
    mcpConfigPath,
  ]
}

interface ContentBlock {
  type: string
  text?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
}

interface ClaudeStreamEvent {
  type: string
  message?: {
    role?: string
    content?: ContentBlock[]
  }
  result?: string
  subtype?: string
}

/** Format a tool_use block into a readable one-liner. */
function formatToolUse(block: ContentBlock): string {
  const name = block.name ?? 'tool'
  const input = block.input ?? {}
  if (name === 'Bash' && input.command) {
    return `\x1b[33m❯\x1b[0m \x1b[90m[${name}]\x1b[0m ${input.command as string}`
  }
  if (name === 'Read' && input.file_path) return `\x1b[33m❯\x1b[0m \x1b[90m[${name}]\x1b[0m ${input.file_path as string}`
  if (name === 'Write' && input.file_path) return `\x1b[33m❯\x1b[0m \x1b[90m[${name}]\x1b[0m ${input.file_path as string}`
  if (name === 'Edit' && input.file_path) return `\x1b[33m❯\x1b[0m \x1b[90m[${name}]\x1b[0m ${input.file_path as string}`
  if (name === 'Glob' && input.pattern) return `\x1b[33m❯\x1b[0m \x1b[90m[${name}]\x1b[0m ${input.pattern as string}`
  if (name === 'Grep' && input.pattern) return `\x1b[33m❯\x1b[0m \x1b[90m[${name}]\x1b[0m ${input.pattern as string}`
  return `\x1b[33m❯\x1b[0m \x1b[90m[${name}]\x1b[0m`
}

/** Extract text from a tool_result content value. */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text: string } => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
  }
  return ''
}

/**
 * Parse a single NDJSON line from the claude --output-format stream-json output.
 * Returns a human-readable string (possibly with ANSI codes), or null to skip.
 */
export function parseClaudeOutput(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let event: ClaudeStreamEvent
  try {
    event = JSON.parse(trimmed)
  } catch {
    // Not JSON — pass through as-is (startup messages etc.)
    return trimmed
  }

  switch (event.type) {
    case 'assistant': {
      const blocks = event.message?.content ?? []
      const parts: string[] = []
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          parts.push(`\x1b[36m${block.text}\x1b[0m`)
        } else if (block.type === 'tool_use') {
          parts.push(formatToolUse(block))
        }
        // skip 'thinking' blocks
      }
      return parts.length > 0 ? parts.join('\n') : null
    }

    case 'user': {
      // Tool results arrive as user messages
      const blocks = event.message?.content ?? []
      const parts: string[] = []
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const text = extractToolResultText(block.content)
          if (text) parts.push(text)
        }
      }
      return parts.length > 0 ? parts.join('\n') : null
    }

    case 'result': {
      if (event.subtype === 'success') return '\x1b[32m✓ Completed\x1b[0m'
      return '\x1b[31m✗ Failed\x1b[0m'
    }

    default:
      return null
  }
}
