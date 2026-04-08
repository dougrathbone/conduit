# Conduit

A managed execution environment for AI CLI agents (Claude Code, Amp, Cursor). Node.js/Express server with React frontend served at `http://localhost:7456`.

## Quick Reference

```bash
npm run dev       # Start dev server (Vite watch + tsx watch)
npm run build     # Production build (Vite + tsc)
npm start         # Run production server
```

## Architecture

- **Server**: Express + WebSocket (`src/server/`) — all client-server communication is WebSocket JSON-RPC at `/ws`
- **Database**: SQLite via better-sqlite3 + Drizzle ORM (`src/main/db/`)
- **Frontend**: React 18 + Vite + TailwindCSS (`src/renderer/`)
- **State**: TanStack Query (server state) + Zustand (UI state)
- **Shared types**: `src/shared/types.ts` — single source of truth for all TypeScript types and the `ConduitAPI` interface

## Key Patterns

**Adding a new entity type** — follow the publish targets pattern:
1. Types in `src/shared/types.ts` (interface + extend `ConduitAPI`)
2. Drizzle schema in `src/main/db/schema.ts`
3. Migrations in `src/main/db/index.ts` (CREATE TABLE IF NOT EXISTS + ALTER TABLE try/catch)
4. Query layer in `src/main/db/queries/<entity>.ts` (rowToEntity, list/get/create/update/delete)
5. Server handlers in `src/server/index.ts` (channel-based: `'entity:list'`, `'entity:create'`, etc.)
6. WS client in `src/renderer/lib/ws-client.ts` + accessor in `src/renderer/lib/ipc.ts`
7. React hooks in `src/renderer/hooks/use<Entity>.ts` (TanStack Query + mutations)
8. UI component in `src/renderer/components/`

**Database conventions:**
- IDs: `crypto.randomUUID()`
- Timestamps: `Date.now()` (unix ms) for `createdAt`/`updatedAt`
- JSON fields stored as TEXT, serialized/deserialized in `rowTo*()` helpers
- Migrations: `ALTER TABLE ... ADD COLUMN` wrapped in try/catch (idempotent)

**WebSocket protocol:**
- Client → Server: `{ type: 'invoke', id, channel, args }`
- Server → Client: `{ type: 'response', id, result }` or `{ type: 'error', id, error }`
- Server → All: `{ type: 'event', channel, payload }` (broadcasts)

## Data Storage

All data lives under `~/.conduit/` (or `$CONDUIT_DATA_DIR`):
- `conduit.db` — SQLite database
- `logs/` — NDJSON run logs (`{runId}.jsonl`)
- `repos/` — Bare git clones for managed repositories
- `prefs.json` — Key-value preferences (GitHub PAT stored as base64)

## TypeScript Configs

- `tsconfig.json` — Root config (shared settings)
- `tsconfig.web.json` — Renderer/frontend (uses path aliases: `@renderer/`, `@shared/`)
- `tsconfig.server.json` — Server compilation to `out/`

## Testing Changes

After modifying code, verify with:
```bash
npx tsc --noEmit                          # Type-check all configs
npx tsc --noEmit --project tsconfig.web.json    # Frontend only
npx tsc --noEmit --project tsconfig.server.json # Server only
npm run build                             # Full production build
```
