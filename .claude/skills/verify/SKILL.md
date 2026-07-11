---
name: verify
description: Build, launch, and drive the Conduit app to observe a change working end-to-end (browser UI at http://localhost:7456).
---

# Verifying Conduit changes

Conduit is a Node/Express + WebSocket server with a React (Vite) frontend served
at `http://localhost:7456`. Data lives in **PostgreSQL** (not SQLite — the CLAUDE.md
is stale on this point). The dev server will not start without a reachable DB.

## Bring up the database (Postgres via podman)

```bash
podman machine start            # if the VM is stopped (check: podman machine list)
npm run db:up                   # starts container conduit-pg (postgres:16-alpine)
# if the container already exists from a prior run:
podman start conduit-pg
# wait until ready:
podman exec conduit-pg pg_isready -U conduit
```

Dev connection string (auto-defaulted by `src/main/db/index.ts` when `DATABASE_URL`
is unset): `postgres://conduit:conduit@localhost:5432/conduit`.

Inspect data directly, e.g.:
```bash
podman exec conduit-pg psql -U conduit -d conduit -tAc "select id,name,mcp_config from agents;"
```

## Launch the app

```bash
npm run dev     # concurrently: vite build --watch + tsx watch src/server/index.ts
# ready when:
curl -s -o /dev/null -w "%{http_code}" http://localhost:7456/     # -> 200
```

Runs in **dev bypass auth** (no Okta env vars) — a synthetic `dev-user` owns
everything, no login. A "DEV" badge shows top-left.

## Drive it (browser)

Use Claude-in-Chrome: `tabs_context_mcp` → `navigate` to `http://localhost:7456/`
→ `computer`/`find`/`read_page`. The left sidebar lists agents (click one → Configure
tab) plus Repositories / Global MCPs / Publish Targets / Settings at the bottom.

Gotchas:
- The agent editor **auto-saves** on a 500ms debounce — no explicit save needed; the
  sidebar re-sorts (most-recently-updated first) when a save lands.
- The JSON config editors are CodeMirror with **auto-close brackets** — type the opening
  `{`/`"` and it inserts the closing one; type your content without the final `}`.
- Don't trigger native dialogs; prefer `read_console_messages` for debugging.

## Cleanup

`podman stop conduit-pg` (leaves data on the named volume). Kill dev with
`pkill -f "tsx watch src/server/index.ts"` and `pkill -f "vite build --watch"`.
