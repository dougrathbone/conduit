/**
 * Build the CLI arguments for the `claude` binary.
 */
export function buildClaudeArgs(prompt: string, mcpConfigPath: string): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--mcp-config',
    mcpConfigPath,
    prompt,
  ]
}

interface ClaudeStreamEvent {
  type: string
  message?: {
    content?: Array<{
      type: string
      text?: string
    }>
  }
  // tool_use at top level (some event shapes)
  name?: string
  input?: unknown
  // tool_result
  content?: unknown
  // result
  result?: string
  subtype?: string
}

/**
 * Parse a single NDJSON line from the claude --output-format stream-json output.
 * Returns a human-readable string, or null if the line should be ignored.
 */
export function parseClaudeOutput(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let event: ClaudeStreamEvent
  try {
    event = JSON.parse(trimmed)
  } catch {
    // Not JSON — return the raw line (e.g. startup messages)
    return trimmed
  }

  switch (event.type) {
    case 'assistant': {
      // Extract text content blocks from the assistant message
      const content = event.message?.content ?? []
      const parts: string[] = []
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text)
        } else if (block.type === 'tool_use' && (block as unknown as { name?: string }).name) {
          parts.push(`[tool: ${(block as unknown as { name: string }).name}]`)
        }
      }
      return parts.length > 0 ? parts.join('') : null
    }

    case 'tool_use': {
      const name = event.name ?? 'unknown'
      return `[tool: ${name}]`
    }

    case 'tool_result': {
      const raw = JSON.stringify(event.content ?? '')
      const truncated = raw.length > 100 ? raw.slice(0, 100) + '…' : raw
      return `[result: ${truncated}]`
    }

    case 'result': {
      if (event.subtype === 'success' || event.result === 'success') {
        return '\n✓ Completed'
      }
      return '\n✗ Failed'
    }

    default:
      return null
  }
}
