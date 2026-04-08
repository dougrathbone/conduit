/**
 * Build the CLI arguments for the `amp` binary.
 */
export function buildAmpArgs(prompt: string, mcpConfigPath: string): string[] {
  return [
    'run',
    '--dangerously-allow-all',
    '--mcp-config',
    mcpConfigPath,
    prompt,
  ]
}

interface AmpStreamEvent {
  type: string
  message?: {
    content?: Array<{
      type: string
      text?: string
      name?: string
    }>
  }
  name?: string
  input?: unknown
  content?: unknown
  result?: string
  subtype?: string
}

/**
 * Parse a single NDJSON line from the amp stream-json output.
 * Amp uses a compatible format to claude's stream-json.
 * Returns a human-readable string, or null if the line should be ignored.
 */
export function parseAmpOutput(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let event: AmpStreamEvent
  try {
    event = JSON.parse(trimmed)
  } catch {
    // Not JSON — return the raw line
    return trimmed
  }

  switch (event.type) {
    case 'assistant': {
      const content = event.message?.content ?? []
      const parts: string[] = []
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text)
        } else if (block.type === 'tool_use' && block.name) {
          parts.push(`[tool: ${block.name}]`)
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
