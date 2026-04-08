/**
 * Build the CLI arguments for the `cursor` binary.
 * Cursor is a GUI application — it opens the workspace folder directly.
 */
export function buildCursorArgs(workspacePath: string): string[] {
  return [workspacePath]
}

/**
 * Message written to the run log when Cursor is launched.
 * Since Cursor is a GUI tool, there is no live streaming output.
 */
export const CURSOR_NOTICE =
  '[Cursor opened workspace. This is a GUI tool — live streaming is not available.]\r\n'
