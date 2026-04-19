# Agent Reporting

## Context

Conduit manages AI CLI agents (Claude Code, Amp, Cursor) with full execution tracking — runs table with status, duration, exit codes, and NDJSON log files. However, there is no analytics or reporting layer. Users cannot see usage trends, token consumption, success rates, or compare agent performance over time. This feature adds reporting at both the global (all agents) and per-agent level.

## Goals

- **Usage analytics**: Run frequency over time, success/failure rates, trends
- **Resource tracking**: Token consumption and tool use counts per agent and globally
- **Flexible time ranges**: Day/week/month grouping with 7d/30d/90d/custom presets

## Data Layer

### Schema Changes

Add two nullable columns to the `runs` table:

| Column | Type | Description |
|--------|------|-------------|
| `totalTokens` | INTEGER | Total tokens consumed, parsed from log `<usage>` block |
| `toolUses` | INTEGER | Number of tool calls, parsed from log `<usage>` block |

Migration: `ALTER TABLE runs ADD COLUMN` wrapped in try/catch (idempotent pattern per CLAUDE.md).

### Usage Extraction

Agent logs (Claude Code) emit `<usage>` blocks in stdout:

```
<usage>total_tokens: 34872
  tool_uses: 29
  duration_ms: 287780</usage>
```

Some variants include ANSI escape codes (`\u001b[0m`, `\u001b[2m`). Extraction regex:

```
/<usage>[\s\S]*?total_tokens:\s*(\d+)[\s\S]*?tool_uses:\s*(\d+)[\s\S]*?<\/usage>/
```

**Extraction point**: After the runner process exits in `src/main/execution/runner.ts`, read the log file, find the last `<usage>` block, and pass `totalTokens`/`toolUses` to `updateRun()`.

**Backfill**: A one-time function scans existing `.jsonl` files in `~/.conduit/logs/`, extracts usage data, and updates corresponding run rows. Runs on server startup if any runs have `totalTokens = NULL` and `status = 'completed'`.

## Query Layer

Three new query functions in `src/main/db/queries/runs.ts`:

### `getRunStats(agentId?, dateRange?)`
Returns aggregated metrics:
- Total runs, completed count, failed count
- Success rate (%)
- Total tokens, average tokens per run
- Total tool uses, average tool uses per run
- Average duration (ms)

### `getRunTimeSeries(agentId?, dateRange?, groupBy: 'day' | 'week' | 'month')`
Returns time-bucketed rows:
- `{ period, runCount, completedCount, failedCount, totalTokens, totalToolUses, avgDurationMs }`
- Grouping via SQLite `strftime` date functions on `startedAt`

### `getAgentLeaderboard(dateRange?)`
Returns per-agent summary rows for the global dashboard:
- Agent name, runner type, run count, success rate, total tokens, average duration
- Sorted by run count descending

## WebSocket API

New channels following existing pattern in `src/server/index.ts`:

| Channel | Args | Returns |
|---------|------|---------|
| `reports:stats` | `[agentId?, startMs?, endMs?]` | `RunStats` |
| `reports:timeseries` | `[agentId?, startMs?, endMs?, groupBy?]` | `TimeSeriesRow[]` |
| `reports:leaderboard` | `[startMs?, endMs?]` | `LeaderboardRow[]` |

## Frontend

### Dependencies

Add **Recharts** (`recharts`) — React-native charting library built on D3. Composable components, good dark mode support via theme CSS variables.

### Shared Components

**`DateRangePicker`** — pill-button selector with 7d/30d/90d presets and a Custom option. Computes `startMs`/`endMs` from selection. Reused on both global and per-agent views.

**`StatCard`** — displays a metric label, value, and optional period-over-period change. Used in both dashboards.

### Global Dashboard — `ReportsDashboard.tsx`

New top-level view accessed via "Reports" entry in the sidebar (alongside Repositories, Global MCPs, Publish Targets).

Layout (top to bottom):
1. Header with "Overview" title + `DateRangePicker` (right-aligned)
2. Four `StatCard` components in a row: Total Runs, Success Rate, Tokens Used, Avg Duration — each with % change vs prior equivalent period
3. Stacked bar chart (Recharts `BarChart`) — completed (indigo) vs failed (red) runs over time
4. Agent leaderboard table — columns: Agent, Runs, Success %, Tokens, Avg Duration

### Per-Agent Reports Tab — `AgentReports.tsx`

New "Reports" tab added to `MainPanel.tsx` tab bar alongside Configure and Runs.

Layout (top to bottom):
1. `DateRangePicker` (right-aligned)
2. Five `StatCard` components: Runs, Success Rate, Tokens, Avg Duration, Tool Uses
3. Runs over time stacked bar chart (completed vs failed)
4. Tokens over time bar chart

### Hooks

- `useReportStats(agentId?, dateRange)` — calls `reports:stats`
- `useReportTimeSeries(agentId?, dateRange, groupBy)` — calls `reports:timeseries`
- `useAgentLeaderboard(dateRange)` — calls `reports:leaderboard`

### Routing

Add route `/reports` to `src/renderer/store/ui.ts` alongside existing routes. Add `showReports` flag to UI store.

## Types

Add to `src/shared/types.ts`:

```typescript
interface RunStats {
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

interface TimeSeriesRow {
  period: string        // e.g. "2026-04-19", "2026-W16", "2026-04"
  runCount: number
  completedCount: number
  failedCount: number
  totalTokens: number
  totalToolUses: number
  avgDurationMs: number
}

interface LeaderboardRow {
  agentId: string
  agentName: string
  runner: string
  runCount: number
  successRate: number
  totalTokens: number
  avgDurationMs: number
}

// Extend ConduitAPI
reports: {
  stats: (agentId?: string, startMs?: number, endMs?: number) => Promise<RunStats>
  timeseries: (agentId?: string, startMs?: number, endMs?: number, groupBy?: 'day' | 'week' | 'month') => Promise<TimeSeriesRow[]>
  leaderboard: (startMs?: number, endMs?: number) => Promise<LeaderboardRow[]>
}
```

## Verification

1. `npx tsc --noEmit` — type-check passes
2. `npm run build` — production build succeeds
3. Start dev server, create an agent, run it, verify `totalTokens`/`toolUses` populated in DB after run completes
4. Navigate to global Reports dashboard — verify stat cards, chart, and leaderboard render with data
5. Navigate to per-agent Reports tab — verify stat cards and charts render
6. Toggle time ranges (7d/30d/90d) — verify data updates
7. Verify backfill populates metrics for existing historical runs on server startup
