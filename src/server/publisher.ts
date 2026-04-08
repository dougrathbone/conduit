import type { ExecutionRun, SlackPublishConfig } from '../shared/types'
import { getPublishTarget } from '../main/db/queries/publishTargets'
import { getAgent } from '../main/db/queries/agents'
import { readLogFile } from './utils'

/**
 * Publish target is a dumb delivery channel — the agent controls the content.
 *
 * Convention: if the agent's stdout contains a block delimited by
 *   <!--CONDUIT:PUBLISH-->
 *   ...content...
 *   <!--/CONDUIT:PUBLISH-->
 * then only that content is posted. Otherwise the full stdout output is sent.
 *
 * This lets agents craft their own Slack messages via their prompt.
 */

const PUBLISH_START = '<!--CONDUIT:PUBLISH-->'
const PUBLISH_END = '<!--/CONDUIT:PUBLISH-->'

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function extractPublishContent(stdout: string): string | null {
  const startIdx = stdout.indexOf(PUBLISH_START)
  if (startIdx === -1) return null
  const contentStart = startIdx + PUBLISH_START.length
  const endIdx = stdout.indexOf(PUBLISH_END, contentStart)
  if (endIdx === -1) return null
  return stdout.slice(contentStart, endIdx).trim()
}

/**
 * Convert markdown formatting to Slack mrkdwn.
 *
 * - **bold** → *bold*
 * - [text](url) → <url|text>
 * - `code` stays as `code`
 * - ```block``` stays as ```block```
 */
function markdownToSlackMrkdwn(text: string): string {
  let result = text

  // Convert markdown links [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')

  // Convert **bold** → *bold* (Slack uses single asterisk)
  // Be careful not to touch already-single asterisks
  result = result.replace(/\*\*([^*]+)\*\*/g, '*$1*')

  return result
}

interface SlackBlock {
  type: string
  text?: { type: string; text: string }
}

async function postToSlack(
  config: SlackPublishConfig,
  message: string
): Promise<void> {
  const slackMessage = markdownToSlackMrkdwn(message)

  // Use a section block for proper mrkdwn rendering
  const blocks: SlackBlock[] = []

  // Slack blocks have a 3000 char limit per text field — split if needed
  const chunks: string[] = []
  if (slackMessage.length <= 3000) {
    chunks.push(slackMessage)
  } else {
    // Split on double-newlines (paragraph boundaries)
    const paragraphs = slackMessage.split(/\n\n+/)
    let current = ''
    for (const p of paragraphs) {
      if (current.length + p.length + 2 > 3000) {
        if (current) chunks.push(current.trim())
        current = p
      } else {
        current += (current ? '\n\n' : '') + p
      }
    }
    if (current) chunks.push(current.trim())
  }

  for (const chunk of chunks) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: chunk },
    })
  }

  const body: Record<string, unknown> = {
    text: message, // Fallback plain text for notifications
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  }
  if (config.iconEmoji) body.icon_emoji = config.iconEmoji

  if (config.webhookUrl) {
    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Slack webhook failed: ${res.status} ${text}`)
    }
  } else if (config.botToken) {
    body.channel = config.channel

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${config.botToken}`,
      },
      body: JSON.stringify(body),
    })
    const data = await res.json() as { ok: boolean; error?: string }
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`)
    }
  } else {
    throw new Error('Slack config requires either webhookUrl or botToken')
  }
}

/**
 * Test a Slack config by sending a test message.
 */
export async function testSlackConfig(
  config: SlackPublishConfig
): Promise<{ success: boolean; error?: string }> {
  try {
    await postToSlack(config, ':test_tube: Conduit test message — this publish target is configured correctly.')
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Publish a run's output to all configured targets for an agent.
 * Called from runner.ts when a run completes successfully.
 *
 * The agent controls the message content — this is just a delivery channel.
 */
export async function publishRunResult(
  agentId: string,
  run: ExecutionRun
): Promise<void> {
  // Only publish on completed runs — the agent produced its output
  if (run.status !== 'completed') return

  const agent = getAgent(agentId)
  if (!agent?.publishTargetIds?.length) return

  // Build the full stdout from the log
  let fullStdout = ''
  try {
    const entries = readLogFile(run.id)
    fullStdout = entries
      .filter((e) => e.stream === 'stdout')
      .map((e) => stripAnsi(e.chunk).trim())
      .filter(Boolean)
      .join('\n')
  } catch {
    return // No log = nothing to publish
  }

  if (!fullStdout) return

  // Extract the publish block if present, otherwise use full output
  const publishContent = extractPublishContent(fullStdout) ?? fullStdout

  // Slack has a 40k char limit on text; truncate if needed
  const message = publishContent.length > 39000
    ? publishContent.slice(0, 39000) + '\n…(truncated)'
    : publishContent

  for (const targetId of agent.publishTargetIds) {
    const target = getPublishTarget(targetId)
    if (!target || !target.enabled) continue

    try {
      if (target.type === 'slack') {
        await postToSlack(target.config, message)
      }
    } catch (err) {
      console.error(`[publisher] Failed to publish to target ${target.name}:`, err)
    }
  }
}
