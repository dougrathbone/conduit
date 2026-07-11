import React from 'react'
import { RunLogView } from '@renderer/components/runs/RunLogView'

interface RunDetailProps {
  runId: string
}

/** Replay view for a finished run. RunLogView renders the structured view for
 *  new (event-format) runs and falls back to the xterm terminal for old ones. */
export function RunDetail({ runId }: RunDetailProps) {
  return <RunLogView runId={runId} />
}
