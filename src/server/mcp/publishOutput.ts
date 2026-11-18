/** Canonical publish-block delimiters. Must stay extractable by `resolveRunPublishMessage`. */
export const PUBLISH_OPEN = '<!--CONDUIT:PUBLISH-->'
export const PUBLISH_CLOSE = '<!--/CONDUIT:PUBLISH-->'

/**
 * What a prompt has to tell its agent so publish targets receive a clean
 * deliverable. Included in the MCP server instructions and the design/improve
 * prompts. Tool descriptions use the shorter {@link PUBLISH_OUTPUT_HINT}.
 */
export const PUBLISH_OUTPUT_GUIDE = `Publish output:
When a run finishes, Conduit posts the agent's output to its publish targets (Slack, email, webhook). The prompt must tell the agent to end with exactly one block of standard markdown, even if no targets are attached yet:

${PUBLISH_OPEN}
The deliverable, in standard markdown (**bold**, [text](url), headings, lists). Not Slack mrkdwn.
${PUBLISH_CLOSE}

- Only the text inside the block is posted. Without a block, Conduit posts the last message and labels it as having no publish summary.
- Once an opening marker appears, surrounding narration is never used as a fallback. An empty block publishes nothing.
- If several blocks appear, the last non-empty one is posted.
- Slack converts that markdown to mrkdwn (headings become bold lines; nested lists flatten). Email becomes HTML. Webhooks receive the markdown unchanged.
- Keep it short: a Slack section is 3000 characters, a message is at most 50 blocks, and the body is cut at 39000 characters.
- Failed runs get Conduit's own failure notice; the prompt does not format those.`

/** One line for tool descriptions, so prompt authors see the contract at the call site. */
export const PUBLISH_OUTPUT_HINT =
  'The prompt must tell the agent to finish with one <!--CONDUIT:PUBLISH--> … <!--/CONDUIT:PUBLISH--> block of standard markdown; that block is the only text posted. With no block, only the last message is delivered and labelled as having no summary.'
