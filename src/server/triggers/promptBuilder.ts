import type { TriggerContext } from '../../shared/types'

/**
 * Build the full prompt for a triggered run by appending context to the agent's base prompt.
 * For cron triggers, no context is appended (scheduled run, no external input).
 */
export function buildTriggeredPrompt(basePrompt: string, context: TriggerContext): string {
  switch (context.triggerType) {
    case 'slack': {
      const meta = context.slackMeta
      const from = meta?.userName ? `@${meta.userName}` : meta?.userId ?? 'unknown'
      const channel = meta?.channelName ? `#${meta.channelName}` : meta?.channelId ?? 'unknown'
      const thread = meta?.threadTs ? `\n- Thread: ${meta.threadTs}` : ''

      return `${basePrompt}

---
## Trigger Context

This run was triggered by a Slack mention from ${from} in ${channel}.

**Message:**
${context.payload ?? '(no message)'}

**Metadata:**
- Channel: ${meta?.channelId ?? 'unknown'}
- User: ${meta?.userId ?? 'unknown'}${thread}

Process this message and respond accordingly.`
    }

    case 'webhook': {
      return `${basePrompt}

---
## Trigger Context

This run was triggered by an inbound webhook.

**Request Body:**
\`\`\`json
${context.payload ?? '{}'}
\`\`\`

Process this webhook payload and respond accordingly.`
    }

    case 'cron':
    default:
      // Scheduled run — no additional context needed
      return basePrompt
  }
}
