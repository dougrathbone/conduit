# Agent Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add usage analytics and resource tracking dashboards — a global cross-agent view and per-agent reports tab — powered by token/tool metrics extracted from run logs.

**Architecture:** Extend the `runs` table with `totalTokens` and `toolUses` columns. Parse `<usage>` blocks from NDJSON log files on run completion, with a one-time backfill for historical data. Three new WS channels serve aggregated stats, time-series, and leaderboard data. Frontend uses Recharts for visualization.

**Tech Stack:** SQLite (better-sqlite3), Drizzle ORM, Recharts, React 18, TanStack Query, Zustand, TailwindCSS

---

## File Structure

### New files
- `src/main/utils/usageParser.ts` — parse `<usage>` blocks from log content
- `src/main/db/queries/reports.ts` — getRunStats, getRunTimeSeries, getAgentLeaderboard
- `src/renderer/hooks/useReports.ts` — TanStack Query hooks for report data
- `src/renderer/components/reports/DateRangePicker.tsx` — time range selector
- `src/renderer/components/reports/StatCard.tsx` — metric display card
- `src/renderer/components/reports/ReportsDashboard.tsx` — global dashboard
- `src/renderer/components/reports/AgentReports.tsx` — per-agent reports tab

### Modified files
- `src/shared/types.ts` — add RunStats, TimeSeriesRow, LeaderboardRow, extend ConduitAPI
- `src/main/db/schema.ts` — add totalTokens, toolUses columns to runs
- `src/main/db/index.ts` — add migration for new columns + backfill call
- `src/main/db/queries/runs.ts` — update rowToExecutionRun, updateRun for new fields
- `src/server/runner.ts` — extract usage after run finalization
- `src/server/index.ts` — add reports:* WS handlers
- `src/renderer/lib/ws-client.ts` — add reports namespace to client
- `src/renderer/lib/ipc.ts` — add reports accessor
- `src/renderer/store/ui.ts` — add showReports state + route
- `src/renderer/components/layout/Sidebar.tsx` — add Reports button
- `src/renderer/components/layout/MainPanel.tsx` — add Reports tab
- `src/renderer/App.tsx` — render ReportsDashboard when showReports=true
- `package.json` — add recharts dependency

---

## Task 1: Add report types to shared types

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add report interfaces and extend ConduitAPI**

Add after the `TriggerFiredPayload` interface (around line 325), before the `ConduitAPI` interface:

```typescript
// ── Reports ────────────────────────────────────────────────────────────────

export interface RunStats {
  totalRuns: number
  completedRuns: number
  failedRuns: number
  successRate: number
  totalTokens: number
  avgTokensPerRun: number
  totalToolUses: number
  avgToolUsesPerRun: number
  avgDurationMs: number
}

export interface TimeSeriesRow {
  period: string
  runCount: number
  completedCount: number
  failedCount: number
  totalTokens: number
  totalToolUses: number
  avgDurationMs: number
}

export interface LeaderboardRow {
  agentId: string
  agentName: string
  runner: string
  runCount: number
  successRate: number
  totalTokens: number
  avgDurationMs: number
}
```

Add `totalTokens` and `toolUses` to the `ExecutionRun` interface (after `exitCode`):

```typescript
  totalTokens?: number
  toolUses?: number
```

Add `reports` namespace inside the `ConduitAPI` interface (after the `groups` block, before the closing `}`):

```typescript
  reports: {
    stats: (agentId?: string, startMs?: number, endMs?: number) => Promise<RunStats>
    timeseries: (agentId?: string, startMs?: number, endMs?: number, groupBy?: 'day' | 'week' | 'month') => Promise<TimeSeriesRow[]>
    leaderboard: (startMs?: number, endMs?: number) => Promise<LeaderboardRow[]>
  }
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit --project tsconfig.web.json`
Expected: no errors (other files don't reference the new types yet)

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(reports): add RunStats, TimeSeriesRow, LeaderboardRow types"
```

---

## Task 2: Schema migration + usage parser

**Files:**
- Create: `src/main/utils/usageParser.ts`
- Modify: `src/main/db/schema.ts`
- Modify: `src/main/db/index.ts`
- Modify: `src/main/db/queries/runs.ts`

- [ ] **Step 1: Add columns to Drizzle schema**

In `src/main/db/schema.ts`, add two columns to the `runs` table definition (after the `startedBy` line):

```typescript
  totalTokens: integer('total_tokens'),
  toolUses: integer('tool_uses'),
```

- [ ] **Step 2: Add migration in initDb**

In `src/main/db/index.ts`, add after the existing migration lines (after `ALTER TABLE runs ADD COLUMN started_by TEXT`):

```typescript
  // Reports: usage metrics extracted from run logs
  try { db.exec('ALTER TABLE runs ADD COLUMN total_tokens INTEGER') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE runs ADD COLUMN tool_uses INTEGER') } catch { /* already exists */ }
```

- [ ] **Step 3: Create usageParser utility**

Create `src/main/utils/usageParser.ts`:

```typescript
/**
 * Parse <usage> blocks from agent log output to extract token and tool-use metrics.
 * Handles both plain text and ANSI-escape-code variants.
 */
export interface UsageMetrics {
  totalTokens: number
  toolUses: number
}

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * Extract usage metrics from raw log content (concatenated chunks).
 * Returns the LAST <usage> block found (the final summary), or null if none.
 */
export function parseUsageFromLog(chunks: string[]): UsageMetrics | null {
  const combined = chunks.join('')
  const cleaned = stripAnsi(combined)

  // Find all <usage>...</usage> blocks and take the last one
  const regex = /<usage>([\s\S]*?)<\/usage>/g
  let lastMatch: string | null = null
  let m: RegExpExecArray | null
  while ((m = regex.exec(cleaned)) !== null) {
    lastMatch = m[1]
  }

  if (!lastMatch) return null

  const tokensMatch = lastMatch.match(/total_tokens:\s*(\d+)/)
  const toolsMatch = lastMatch.match(/tool_uses:\s*(\d+)/)

  if (!tokensMatch) return null

  return {
    totalTokens: parseInt(tokensMatch[1], 10),
    toolUses: toolsMatch ? parseInt(toolsMatch[1], 10) : 0,
  }
}
```

- [ ] **Step 4: Update rowToExecutionRun and updateRun**

In `src/main/db/queries/runs.ts`, add to the `rowToExecutionRun` return object (after `startedBy`):

```typescript
    totalTokens: row.totalTokens ?? undefined,
    toolUses: row.toolUses ?? undefined,
```

In the `updateRun` function, add handling for the new fields (after the `exitCode` block):

```typescript
  if ('totalTokens' in data) updateValues.totalTokens = data.totalTokens ?? null
  if ('toolUses' in data) updateValues.toolUses = data.toolUses ?? null
```

- [ ] **Step 5: Verify types compile**

Run: `npx tsc --noEmit --project tsconfig.server.json`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/main/utils/usageParser.ts src/main/db/schema.ts src/main/db/index.ts src/main/db/queries/runs.ts
git commit -m "feat(reports): add totalTokens/toolUses columns and usage parser"
```

---

## Task 3: Extract usage on run completion + backfill

**Files:**
- Modify: `src/server/runner.ts`
- Modify: `src/main/db/index.ts`
- Modify: `src/server/utils.ts`

- [ ] **Step 1: Add extraction to server runner's finalizeRun**

In `src/server/runner.ts`, add import at the top:

```typescript
import { parseUsageFromLog } from '../main/utils/usageParser'
import { readLogFile } from './utils'
```

In the `finalizeRun` function, after the `logStream.end()` call and before the `updateRun` call (around line 192), add usage extraction:

```typescript
    // Extract token/tool usage from log
    let totalTokens: number | undefined
    let toolUses: number | undefined
    try {
      const entries = readLogFile(runId)
      const stdoutChunks = entries
        .filter((e) => e.stream === 'stdout')
        .map((e) => e.chunk)
      const usage = parseUsageFromLog(stdoutChunks)
      if (usage) {
        totalTokens = usage.totalTokens
        toolUses = usage.toolUses
      }
    } catch (err) {
      console.error(`[server/runner] Failed to extract usage for run ${runId}:`, err)
    }
```

Then update the `updateRun` call to include the new fields:

```typescript
    const finalRun = updateRun(runId, {
      status,
      endedAt,
      durationMs,
      exitCode: exitCode ?? undefined,
      totalTokens,
      toolUses,
    })
```

- [ ] **Step 2: Add backfill function**

In `src/server/utils.ts`, add import and backfill function:

```typescript
import { parseUsageFromLog } from '../main/utils/usageParser'

/**
 * Backfill totalTokens/toolUses for completed runs that don't have them yet.
 * Reads each run's JSONL log file and extracts usage metrics.
 */
export function backfillUsageMetrics(): number {
  // Import here to avoid circular dependency at module load
  const { drizzleDb } = require('../main/db/index')
  const { runs } = require('../main/db/schema')
  const { eq, isNull, and } = require('drizzle-orm')
  const { updateRun } = require('../main/db/queries/runs')

  const rows = drizzleDb
    .select()
    .from(runs)
    .where(and(eq(runs.status, 'completed'), isNull(runs.totalTokens)))
    .all()

  let filled = 0
  for (const row of rows) {
    try {
      const entries = readLogFile(row.id)
      const stdoutChunks = entries
        .filter((e: LogEntry) => e.stream === 'stdout')
        .map((e: LogEntry) => e.chunk)
      const usage = parseUsageFromLog(stdoutChunks)
      if (usage) {
        updateRun(row.id, {
          totalTokens: usage.totalTokens,
          toolUses: usage.toolUses,
        })
        filled++
      }
    } catch {
      // Skip — log file may be missing or corrupted
    }
  }

  return filled
}
```

- [ ] **Step 3: Call backfill on server startup**

In `src/server/index.ts`, add import:

```typescript
import { backfillUsageMetrics } from './utils'
```

After the orphaned runs block (around line 603), add:

```typescript
// Backfill usage metrics for completed runs missing token data
const backfilled = backfillUsageMetrics()
if (backfilled > 0) {
  console.log(`[server] Backfilled usage metrics for ${backfilled} run(s)`)
}
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit --project tsconfig.server.json`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/server/runner.ts src/server/utils.ts src/server/index.ts
git commit -m "feat(reports): extract usage on run completion + backfill"
```

---

## Task 4: Report query functions

**Files:**
- Create: `src/main/db/queries/reports.ts`

- [ ] **Step 1: Create reports query module**

Create `src/main/db/queries/reports.ts`:

```typescript
import { sql, eq, and, gte, lte } from 'drizzle-orm'
import { drizzleDb } from '../index'
import { runs } from '../schema'
import { agents } from '../schema'
import type { RunStats, TimeSeriesRow, LeaderboardRow } from '../../../shared/types'

interface DateRange {
  startMs?: number
  endMs?: number
}

function dateFilters(agentId?: string, range?: DateRange) {
  const conditions = []
  if (agentId) conditions.push(eq(runs.agentId, agentId))
  if (range?.startMs) conditions.push(gte(runs.startedAt, range.startMs))
  if (range?.endMs) conditions.push(lte(runs.startedAt, range.endMs))
  return conditions.length > 0 ? and(...conditions) : undefined
}

export function getRunStats(agentId?: string, startMs?: number, endMs?: number): RunStats {
  const where = dateFilters(agentId, { startMs, endMs })

  const row = drizzleDb
    .select({
      totalRuns: sql<number>`count(*)`,
      completedRuns: sql<number>`sum(case when ${runs.status} = 'completed' then 1 else 0 end)`,
      failedRuns: sql<number>`sum(case when ${runs.status} = 'failed' then 1 else 0 end)`,
      totalTokens: sql<number>`coalesce(sum(${runs.totalTokens}), 0)`,
      avgTokensPerRun: sql<number>`coalesce(avg(${runs.totalTokens}), 0)`,
      totalToolUses: sql<number>`coalesce(sum(${runs.toolUses}), 0)`,
      avgToolUsesPerRun: sql<number>`coalesce(avg(${runs.toolUses}), 0)`,
      avgDurationMs: sql<number>`coalesce(avg(${runs.durationMs}), 0)`,
    })
    .from(runs)
    .where(where)
    .get()!

  const totalRuns = Number(row.totalRuns) || 0
  const completedRuns = Number(row.completedRuns) || 0

  return {
    totalRuns,
    completedRuns,
    failedRuns: Number(row.failedRuns) || 0,
    successRate: totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : 0,
    totalTokens: Number(row.totalTokens) || 0,
    avgTokensPerRun: Math.round(Number(row.avgTokensPerRun) || 0),
    totalToolUses: Number(row.totalToolUses) || 0,
    avgToolUsesPerRun: Math.round(Number(row.avgToolUsesPerRun) || 0),
    avgDurationMs: Math.round(Number(row.avgDurationMs) || 0),
  }
}

export function getRunTimeSeries(
  agentId?: string,
  startMs?: number,
  endMs?: number,
  groupBy: 'day' | 'week' | 'month' = 'day'
): TimeSeriesRow[] {
  const where = dateFilters(agentId, { startMs, endMs })

  // SQLite strftime format for grouping
  const format = groupBy === 'month'
    ? '%Y-%m'
    : groupBy === 'week'
      ? '%Y-W%W'
      : '%Y-%m-%d'

  const rows = drizzleDb
    .select({
      period: sql<string>`strftime(${format}, ${runs.startedAt} / 1000, 'unixepoch')`,
      runCount: sql<number>`count(*)`,
      completedCount: sql<number>`sum(case when ${runs.status} = 'completed' then 1 else 0 end)`,
      failedCount: sql<number>`sum(case when ${runs.status} = 'failed' then 1 else 0 end)`,
      totalTokens: sql<number>`coalesce(sum(${runs.totalTokens}), 0)`,
      totalToolUses: sql<number>`coalesce(sum(${runs.toolUses}), 0)`,
      avgDurationMs: sql<number>`coalesce(avg(${runs.durationMs}), 0)`,
    })
    .from(runs)
    .where(where)
    .groupBy(sql`strftime(${format}, ${runs.startedAt} / 1000, 'unixepoch')`)
    .orderBy(sql`strftime(${format}, ${runs.startedAt} / 1000, 'unixepoch')`)
    .all()

  return rows.map((r) => ({
    period: r.period,
    runCount: Number(r.runCount) || 0,
    completedCount: Number(r.completedCount) || 0,
    failedCount: Number(r.failedCount) || 0,
    totalTokens: Number(r.totalTokens) || 0,
    totalToolUses: Number(r.totalToolUses) || 0,
    avgDurationMs: Math.round(Number(r.avgDurationMs) || 0),
  }))
}

export function getAgentLeaderboard(startMs?: number, endMs?: number): LeaderboardRow[] {
  const conditions = []
  if (startMs) conditions.push(gte(runs.startedAt, startMs))
  if (endMs) conditions.push(lte(runs.startedAt, endMs))
  const where = conditions.length > 0 ? and(...conditions) : undefined

  const rows = drizzleDb
    .select({
      agentId: runs.agentId,
      agentName: agents.name,
      runner: agents.runner,
      runCount: sql<number>`count(*)`,
      completedRuns: sql<number>`sum(case when ${runs.status} = 'completed' then 1 else 0 end)`,
      totalTokens: sql<number>`coalesce(sum(${runs.totalTokens}), 0)`,
      avgDurationMs: sql<number>`coalesce(avg(${runs.durationMs}), 0)`,
    })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .where(where)
    .groupBy(runs.agentId)
    .orderBy(sql`count(*) desc`)
    .all()

  return rows.map((r) => {
    const runCount = Number(r.runCount) || 0
    const completedRuns = Number(r.completedRuns) || 0
    return {
      agentId: r.agentId,
      agentName: r.agentName,
      runner: r.runner,
      runCount,
      successRate: runCount > 0 ? Math.round((completedRuns / runCount) * 100) : 0,
      totalTokens: Number(r.totalTokens) || 0,
      avgDurationMs: Math.round(Number(r.avgDurationMs) || 0),
    }
  })
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit --project tsconfig.server.json`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/main/db/queries/reports.ts
git commit -m "feat(reports): add report query functions (stats, timeseries, leaderboard)"
```

---

## Task 5: WebSocket handlers + client wiring

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/renderer/lib/ws-client.ts`
- Modify: `src/renderer/lib/ipc.ts`

- [ ] **Step 1: Add WS handlers for reports**

In `src/server/index.ts`, add import:

```typescript
import { getRunStats, getRunTimeSeries, getAgentLeaderboard } from '../main/db/queries/reports'
```

Add handlers inside the `handlers` object (after the `groups:list` handler):

```typescript
  // Reports
  'reports:stats': ([agentId, startMs, endMs]) =>
    Promise.resolve(getRunStats(agentId as string | undefined, startMs as number | undefined, endMs as number | undefined)),
  'reports:timeseries': ([agentId, startMs, endMs, groupBy]) =>
    Promise.resolve(getRunTimeSeries(
      agentId as string | undefined,
      startMs as number | undefined,
      endMs as number | undefined,
      (groupBy as 'day' | 'week' | 'month') || 'day'
    )),
  'reports:leaderboard': ([startMs, endMs]) =>
    Promise.resolve(getAgentLeaderboard(startMs as number | undefined, endMs as number | undefined)),
```

- [ ] **Step 2: Add reports to WS client**

In `src/renderer/lib/ws-client.ts`, add the import for report types at the top:

```typescript
import type { RunStats, TimeSeriesRow, LeaderboardRow } from '@shared/types'
```

Add the `reports` namespace in the returned object (after the `groups` block):

```typescript
    reports: {
      stats: (agentId?: string, startMs?: number, endMs?: number) =>
        invoke<RunStats>('reports:stats', agentId, startMs, endMs),
      timeseries: (agentId?: string, startMs?: number, endMs?: number, groupBy?: 'day' | 'week' | 'month') =>
        invoke<TimeSeriesRow[]>('reports:timeseries', agentId, startMs, endMs, groupBy),
      leaderboard: (startMs?: number, endMs?: number) =>
        invoke<LeaderboardRow[]>('reports:leaderboard', startMs, endMs),
    },
```

- [ ] **Step 3: Add reports accessor to ipc.ts**

In `src/renderer/lib/ipc.ts`, add:

```typescript
  get reports() {
    return getConduit().reports
  },
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit --project tsconfig.server.json && npx tsc --noEmit --project tsconfig.web.json`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/renderer/lib/ws-client.ts src/renderer/lib/ipc.ts
git commit -m "feat(reports): add WS handlers and client wiring for report channels"
```

---

## Task 6: Install Recharts + add report hooks

**Files:**
- Modify: `package.json`
- Create: `src/renderer/hooks/useReports.ts`

- [ ] **Step 1: Install Recharts**

```bash
npm install recharts
```

- [ ] **Step 2: Create report hooks**

Create `src/renderer/hooks/useReports.ts`:

```typescript
import { useQuery } from '@tanstack/react-query'
import { api } from '@renderer/lib/ipc'

export function useReportStats(agentId?: string, startMs?: number, endMs?: number) {
  return useQuery({
    queryKey: ['report-stats', agentId, startMs, endMs],
    queryFn: () => api.reports.stats(agentId, startMs, endMs),
  })
}

export function useReportTimeSeries(
  agentId?: string,
  startMs?: number,
  endMs?: number,
  groupBy?: 'day' | 'week' | 'month'
) {
  return useQuery({
    queryKey: ['report-timeseries', agentId, startMs, endMs, groupBy],
    queryFn: () => api.reports.timeseries(agentId, startMs, endMs, groupBy),
  })
}

export function useAgentLeaderboard(startMs?: number, endMs?: number) {
  return useQuery({
    queryKey: ['report-leaderboard', startMs, endMs],
    queryFn: () => api.reports.leaderboard(startMs, endMs),
  })
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit --project tsconfig.web.json`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/renderer/hooks/useReports.ts
git commit -m "feat(reports): add recharts dependency and report hooks"
```

---

## Task 7: Shared UI components (DateRangePicker + StatCard)

**Files:**
- Create: `src/renderer/components/reports/DateRangePicker.tsx`
- Create: `src/renderer/components/reports/StatCard.tsx`

- [ ] **Step 1: Create DateRangePicker**

Create `src/renderer/components/reports/DateRangePicker.tsx`:

```tsx
import React from 'react'
import { cn } from '@renderer/lib/utils'

export type DatePreset = '7d' | '30d' | '90d' | 'custom'
export type GroupBy = 'day' | 'week' | 'month'

interface DateRangePickerProps {
  preset: DatePreset
  groupBy: GroupBy
  onPresetChange: (preset: DatePreset) => void
  onGroupByChange: (groupBy: GroupBy) => void
}

const presets: { value: DatePreset; label: string }[] = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
]

const groupByOptions: { value: GroupBy; label: string }[] = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
]

export function presetToRange(preset: DatePreset): { startMs: number; endMs: number } {
  const now = Date.now()
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90
  return { startMs: now - days * 24 * 60 * 60 * 1000, endMs: now }
}

export function DateRangePicker({ preset, groupBy, onPresetChange, onGroupByChange }: DateRangePickerProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-1 bg-[var(--bg-secondary)] rounded-md p-0.5">
        {groupByOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onGroupByChange(opt.value)}
            className={cn(
              'px-2.5 py-1 rounded text-xs font-medium transition-colors',
              groupBy === opt.value
                ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="flex gap-1 bg-[var(--bg-secondary)] rounded-md p-0.5">
        {presets.map((p) => (
          <button
            key={p.value}
            onClick={() => onPresetChange(p.value)}
            className={cn(
              'px-2.5 py-1 rounded text-xs font-medium transition-colors',
              preset === p.value
                ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create StatCard**

Create `src/renderer/components/reports/StatCard.tsx`:

```tsx
import React from 'react'

interface StatCardProps {
  label: string
  value: string
  change?: { value: number; label: string }
}

export function StatCard({ label, value, change }: StatCardProps) {
  return (
    <div className="bg-[var(--bg-secondary)] rounded-lg p-3">
      <div className="text-[10px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
        {label}
      </div>
      <div className="text-xl font-bold text-[var(--text-primary)] mt-0.5">
        {value}
      </div>
      {change && (
        <div
          className={`text-[11px] mt-0.5 ${
            change.value > 0 ? 'text-green-400' : change.value < 0 ? 'text-red-400' : 'text-[var(--text-secondary)]'
          }`}
        >
          {change.value > 0 ? '+' : ''}{change.value}% {change.label}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit --project tsconfig.web.json`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/reports/DateRangePicker.tsx src/renderer/components/reports/StatCard.tsx
git commit -m "feat(reports): add DateRangePicker and StatCard components"
```

---

## Task 8: Global Reports Dashboard

**Files:**
- Create: `src/renderer/components/reports/ReportsDashboard.tsx`
- Modify: `src/renderer/store/ui.ts`
- Modify: `src/renderer/components/layout/Sidebar.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add showReports to UI store**

In `src/renderer/store/ui.ts`, add `showReports` to the interface and state:

Add to `UIState` interface:
```typescript
  showReports: boolean
  setShowReports: (show: boolean) => void
```

In `readUrlState`, add:
```typescript
  const reports = path === '/reports'
```
And return `reports` in the returned object.

In the `useUIStore` create call, add:
```typescript
  showReports: initialUrl.reports,
```

Add setter:
```typescript
  setShowReports: (show) => {
    pushUrl(show ? '/reports' : '/')
    set({ showReports: show, showGlobalMcpManager: false, showPublishTargets: false, showRepositories: false, selectedAgentId: null })
  },
```

Update `selectAgent` to also clear `showReports`:
```typescript
  selectAgent: (id) => {
    pushUrl(id ? `/agents/${id}` : '/')
    set({ selectedAgentId: id, showGlobalMcpManager: false, showPublishTargets: false, showRepositories: false, showReports: false })
  },
```

Also clear `showReports: false` in the existing `setShowGlobalMcpManager`, `setShowPublishTargets`, and `setShowRepositories` setters.

- [ ] **Step 2: Create ReportsDashboard**

Create `src/renderer/components/reports/ReportsDashboard.tsx`:

```tsx
import React, { useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { useReportStats, useReportTimeSeries, useAgentLeaderboard } from '@renderer/hooks/useReports'
import { DateRangePicker, presetToRange, type DatePreset, type GroupBy } from './DateRangePicker'
import { StatCard } from './StatCard'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

export function ReportsDashboard() {
  const [preset, setPreset] = useState<DatePreset>('30d')
  const [groupBy, setGroupBy] = useState<GroupBy>('day')

  const { startMs, endMs } = presetToRange(preset)

  const { data: stats } = useReportStats(undefined, startMs, endMs)
  const { data: timeseries } = useReportTimeSeries(undefined, startMs, endMs, groupBy)
  const { data: leaderboard } = useAgentLeaderboard(startMs, endMs)

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--bg-primary)' }}>
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">Reports</h1>
          <DateRangePicker
            preset={preset}
            groupBy={groupBy}
            onPresetChange={setPreset}
            onGroupByChange={setGroupBy}
          />
        </div>

        {/* Stat cards */}
        {stats && (
          <div className="grid grid-cols-4 gap-3">
            <StatCard label="Total Runs" value={String(stats.totalRuns)} />
            <StatCard
              label="Success Rate"
              value={`${stats.successRate}%`}
            />
            <StatCard label="Tokens Used" value={formatTokens(stats.totalTokens)} />
            <StatCard label="Avg Duration" value={formatDuration(stats.avgDurationMs)} />
          </div>
        )}

        {/* Runs over time chart */}
        {timeseries && timeseries.length > 0 && (
          <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-[var(--text-secondary)]">Runs Over Time</span>
              <div className="flex gap-3 text-xs">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-[var(--accent)]" />
                  Completed
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-red-400" />
                  Failed
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={timeseries}>
                <XAxis
                  dataKey="period"
                  tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="completedCount" stackId="runs" fill="var(--accent)" radius={[2, 2, 0, 0]} name="Completed" />
                <Bar dataKey="failedCount" stackId="runs" fill="#f87171" radius={[2, 2, 0, 0]} name="Failed" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Agent leaderboard */}
        {leaderboard && leaderboard.length > 0 && (
          <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
            <div className="text-sm text-[var(--text-secondary)] mb-3">Agent Leaderboard</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--border)]">
                  <th className="pb-2 font-medium">Agent</th>
                  <th className="pb-2 font-medium">Runs</th>
                  <th className="pb-2 font-medium">Success</th>
                  <th className="pb-2 font-medium">Tokens</th>
                  <th className="pb-2 font-medium">Avg Duration</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((row) => (
                  <tr key={row.agentId} className="border-b border-[var(--border)] last:border-0">
                    <td className="py-2.5 text-[var(--text-primary)]">{row.agentName}</td>
                    <td className="py-2.5 text-[var(--text-primary)]">{row.runCount}</td>
                    <td className="py-2.5">
                      <span className={row.successRate >= 80 ? 'text-green-400' : row.successRate >= 50 ? 'text-yellow-400' : 'text-red-400'}>
                        {row.successRate}%
                      </span>
                    </td>
                    <td className="py-2.5 text-[var(--text-primary)]">{formatTokens(row.totalTokens)}</td>
                    <td className="py-2.5 text-[var(--text-primary)]">{formatDuration(row.avgDurationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Empty state */}
        {stats && stats.totalRuns === 0 && (
          <div className="text-center py-12 text-[var(--text-secondary)] text-sm">
            No runs found in this time range. Run some agents to see reports here.
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Add Reports button to Sidebar**

In `src/renderer/components/layout/Sidebar.tsx`, add the `BarChart3` icon import:

```typescript
import { Plus, Sun, Moon, Monitor, Server, Send, FolderGit2, BarChart3 } from 'lucide-react'
```

Destructure `showReports` and `setShowReports` from the store:

```typescript
const { theme, setTheme, selectAgent, showGlobalMcpManager, setShowGlobalMcpManager, showPublishTargets, setShowPublishTargets, showRepositories, setShowRepositories, showReports, setShowReports } = useUIStore()
```

Add a Reports button in the footer `div` (before the Repositories button):

```tsx
        <button
          onClick={() => setShowReports(true)}
          className={cn(
            'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs font-medium transition-colors',
            showReports
              ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
          )}
        >
          <BarChart3 className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1 text-left">Reports</span>
        </button>
```

- [ ] **Step 4: Render ReportsDashboard in App.tsx**

In `src/renderer/App.tsx`, add import:

```typescript
import { ReportsDashboard } from './components/reports/ReportsDashboard'
```

Destructure `showReports` from the store:

```typescript
const { selectedAgentId, selectAgent, showGlobalMcpManager, showPublishTargets, showRepositories, showReports } = useUIStore()
```

In the main content panel, add the reports condition (before `showRepositories`):

```tsx
            {showReports ? (
              <ReportsDashboard />
            ) : showRepositories ? (
```

- [ ] **Step 5: Verify types compile and build**

Run: `npx tsc --noEmit --project tsconfig.web.json`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/reports/ReportsDashboard.tsx src/renderer/store/ui.ts src/renderer/components/layout/Sidebar.tsx src/renderer/App.tsx
git commit -m "feat(reports): add global Reports dashboard with charts and leaderboard"
```

---

## Task 9: Per-Agent Reports Tab

**Files:**
- Create: `src/renderer/components/reports/AgentReports.tsx`
- Modify: `src/renderer/components/layout/MainPanel.tsx`

- [ ] **Step 1: Create AgentReports component**

Create `src/renderer/components/reports/AgentReports.tsx`:

```tsx
import React, { useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useReportStats, useReportTimeSeries } from '@renderer/hooks/useReports'
import { DateRangePicker, presetToRange, type DatePreset, type GroupBy } from './DateRangePicker'
import { StatCard } from './StatCard'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

interface AgentReportsProps {
  agentId: string
}

export function AgentReports({ agentId }: AgentReportsProps) {
  const [preset, setPreset] = useState<DatePreset>('30d')
  const [groupBy, setGroupBy] = useState<GroupBy>('day')

  const { startMs, endMs } = presetToRange(preset)

  const { data: stats } = useReportStats(agentId, startMs, endMs)
  const { data: timeseries } = useReportTimeSeries(agentId, startMs, endMs, groupBy)

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Time picker */}
        <div className="flex justify-end">
          <DateRangePicker
            preset={preset}
            groupBy={groupBy}
            onPresetChange={setPreset}
            onGroupByChange={setGroupBy}
          />
        </div>

        {/* Stat cards */}
        {stats && (
          <div className="grid grid-cols-5 gap-3">
            <StatCard label="Runs" value={String(stats.totalRuns)} />
            <StatCard label="Success Rate" value={`${stats.successRate}%`} />
            <StatCard label="Tokens" value={formatTokens(stats.totalTokens)} />
            <StatCard label="Avg Duration" value={formatDuration(stats.avgDurationMs)} />
            <StatCard label="Tool Uses" value={String(stats.totalToolUses)} />
          </div>
        )}

        {/* Runs over time */}
        {timeseries && timeseries.length > 0 && (
          <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-[var(--text-secondary)]">Runs Over Time</span>
              <div className="flex gap-3 text-xs">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-[var(--accent)]" />
                  Completed
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-red-400" />
                  Failed
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={timeseries}>
                <XAxis
                  dataKey="period"
                  tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="completedCount" stackId="runs" fill="var(--accent)" radius={[2, 2, 0, 0]} name="Completed" />
                <Bar dataKey="failedCount" stackId="runs" fill="#f87171" radius={[2, 2, 0, 0]} name="Failed" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Tokens over time */}
        {timeseries && timeseries.length > 0 && (
          <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
            <div className="text-sm text-[var(--text-secondary)] mb-3">Tokens Over Time</div>
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={timeseries}>
                <XAxis
                  dataKey="period"
                  tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => formatTokens(v)}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value: number) => [formatTokens(value), 'Tokens']}
                />
                <Bar dataKey="totalTokens" fill="var(--accent)" radius={[2, 2, 0, 0]} opacity={0.7} name="Tokens" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Empty state */}
        {stats && stats.totalRuns === 0 && (
          <div className="text-center py-12 text-[var(--text-secondary)] text-sm">
            No runs found in this time range.
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add Reports tab to MainPanel**

In `src/renderer/components/layout/MainPanel.tsx`, add import:

```typescript
import { AgentReports } from '@renderer/components/reports/AgentReports'
```

Change the `Tab` type to include reports:

```typescript
type Tab = 'configure' | 'runs' | 'reports'
```

The existing tab bar iterates over `(['configure', 'runs'] as Tab[])`. Update to:

```typescript
{(['configure', 'runs', 'reports'] as Tab[]).map((t) => (
```

Add the reports content panel after the `{tab === 'runs' && ...}` block:

```tsx
        {tab === 'reports' && (
          <AgentReports agentId={agentId} />
        )}
```

- [ ] **Step 3: Verify full build**

Run: `npm run build`
Expected: build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/reports/AgentReports.tsx src/renderer/components/layout/MainPanel.tsx
git commit -m "feat(reports): add per-agent Reports tab with charts"
```

---

## Task 10: Final verification

- [ ] **Step 1: Type-check all configs**

```bash
npx tsc --noEmit --project tsconfig.server.json
npx tsc --noEmit --project tsconfig.web.json
```

Expected: no errors on either

- [ ] **Step 2: Full production build**

```bash
npm run build
```

Expected: build completes successfully

- [ ] **Step 3: Manual smoke test**

Start dev server with `npm run dev` and verify:
1. Navigate to Reports in the sidebar — dashboard loads with stat cards, chart, and leaderboard (may show empty state if no runs exist)
2. Toggle time range presets (7d/30d/90d) — data updates
3. Toggle grouping (Daily/Weekly/Monthly) — chart buckets change
4. Click an agent, go to the Reports tab — per-agent stats and charts render
5. If historical runs exist, verify backfill populated token data in the leaderboard

- [ ] **Step 4: Commit any fixes from smoke test**

```bash
git add -A
git commit -m "fix(reports): address issues found during smoke test"
```
