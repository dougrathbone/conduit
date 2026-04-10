# Multi-User Authentication & Sharing — Design Spec

## Context

Conduit is currently a single-user application with no authentication, no user model, and no data isolation. All entities (agents, triggers, publish targets, repositories, MCP servers) are globally visible and editable by anyone with network access. The only access control is an IP allowlist.

This design adds multi-user support via Okta OIDC, per-entity ownership, and group-based sharing — transforming Conduit from a personal tool into a collaborative internal team tool.

**Deployment context:** Internal team tool on company infrastructure. Known set of employees. Okta provides identity and group membership.

**Key decisions made:**
- OIDC Authorization Code + PKCE (not SAML, not Okta Widget)
- Full collaboration sharing (shared users can edit, not just view/run)
- Per-entity sharing model (not workspace/folder, not tag-based)
- Okta groups as sharing targets (flat initially, hierarchy-ready schema)
- All entity types get ownership + sharing
- Shared service credentials (global PAT/tokens, not per-user)
- Dev bypass mode for local development (zero auth config needed)

---

## 1. Authentication: Okta OIDC + Dev Bypass

### Production Flow (OIDC Authorization Code + PKCE)

1. User visits Conduit → Express middleware checks for session cookie
2. No valid session → `302` redirect to Okta authorization endpoint
   - Parameters: `client_id`, `redirect_uri`, `response_type=code`, `scope=openid profile email groups`, `code_challenge` (PKCE S256), `state` (CSRF)
3. User authenticates at Okta → redirected to `/auth/callback` with auth code
4. Server exchanges auth code for tokens (ID token, access token, refresh token)
5. Server extracts user info + groups from ID token claims
6. Server creates/updates `users` row, syncs group memberships, creates session in `sessions` table
7. Sets `HttpOnly`, `SameSite=Lax`, `Secure` (in prod) session cookie
8. Redirects to the app (`/`)

### Dev Bypass Mode

Activated when Okta config env vars are absent (i.e., `CONDUIT_OKTA_ISSUER` is not set).

- A synthetic dev user is injected into every request:
  ```
  { id: 'dev-user', email: 'dev@localhost', name: 'Developer', groups: ['everyone'] }
  ```
- All visibility queries return all entities (current single-user behavior preserved exactly)
- No login page shown; app loads directly
- Zero configuration needed for local development

### Session Management

- Sessions stored in SQLite `sessions` table (no Redis dependency)
- Session ID: UUID, stored in cookie
- Server stores Okta access + refresh tokens per session
- Auto-refresh: before access token expiry, use refresh token to get new tokens
- Session expiry: configurable via `CONDUIT_SESSION_TTL_MS`, default 24 hours
- Logout: destroys session row, clears cookie

### HTTP Auth Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/auth/login` | GET | Initiates OIDC flow → redirect to Okta |
| `/auth/callback` | GET | Handles Okta redirect, exchanges code, creates session |
| `/auth/logout` | POST | Destroys session, clears cookie |
| `/auth/me` | GET | Returns current user + groups (frontend bootstrap) |

### WebSocket Auth

- On WebSocket upgrade, parse session cookie from the HTTP upgrade request headers
- Look up session in `sessions` table
- Reject upgrade if session is invalid/expired
- Attach `userId` and `userGroupIds` to the WebSocket connection object
- All WS handlers receive this context automatically

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CONDUIT_OKTA_ISSUER` | For auth | Okta issuer URL (e.g., `https://company.okta.com/oauth2/default`) |
| `CONDUIT_OKTA_CLIENT_ID` | For auth | Okta OIDC application client ID |
| `CONDUIT_OKTA_CLIENT_SECRET` | For auth | Okta OIDC application client secret |
| `CONDUIT_OKTA_REDIRECT_URI` | For auth | Callback URL (e.g., `http://localhost:7456/auth/callback`) |
| `CONDUIT_SESSION_TTL_MS` | No | Session lifetime, default `86400000` (24h) |
| `CONDUIT_SESSION_SECRET` | For auth | Secret for signing session cookies |

When `CONDUIT_OKTA_ISSUER` is not set, auth is disabled entirely (dev bypass mode).

---

## 2. Data Model

### New Tables

#### `users`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | Okta subject ID (`sub` claim), or `'dev-user'` in dev mode |
| email | TEXT | NOT NULL | From Okta token |
| name | TEXT | NOT NULL | Display name from Okta profile |
| avatarUrl | TEXT | | Optional, from Okta profile |
| lastLoginAt | INTEGER | NOT NULL | Unix ms |
| createdAt | INTEGER | NOT NULL | Unix ms |

#### `groups`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | Okta group ID |
| name | TEXT | NOT NULL | Group display name |
| parentGroupId | TEXT | FK → groups.id | For future hierarchy support (nullable) |
| createdAt | INTEGER | NOT NULL | Unix ms |
| updatedAt | INTEGER | NOT NULL | Unix ms |

#### `user_groups`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| userId | TEXT | FK → users.id | |
| groupId | TEXT | FK → groups.id | |
| | | PK (userId, groupId) | Composite primary key |

#### `sessions`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | Session token (UUID) |
| userId | TEXT | FK → users.id, NOT NULL | |
| accessToken | TEXT | NOT NULL | Okta access token (encrypted at rest) |
| refreshToken | TEXT | | Okta refresh token (encrypted at rest) |
| expiresAt | INTEGER | NOT NULL | Token expiry (Unix ms) |
| createdAt | INTEGER | NOT NULL | Unix ms |

#### `shares`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | UUID |
| entityType | TEXT | NOT NULL | `'agent'` \| `'publishTarget'` \| `'repository'` \| `'globalMcpServer'` |
| entityId | TEXT | NOT NULL | FK to the owned entity |
| targetType | TEXT | NOT NULL | `'user'` \| `'group'` \| `'everyone'` |
| targetId | TEXT | | user.id or group.id; NULL when targetType is `'everyone'` |
| createdBy | TEXT | FK → users.id, NOT NULL | Who created this share |
| createdAt | INTEGER | NOT NULL | Unix ms |
| | | UNIQUE (entityType, entityId, targetType, targetId) | Prevent duplicate shares |

### Modified Existing Tables

Each of these tables gets a new column:

| Table | New Column | Type | Notes |
|-------|-----------|------|-------|
| `agents` | `ownerId` | TEXT (FK → users.id) | Set on creation. In dev mode: `'dev-user'` |
| `publishTargets` | `ownerId` | TEXT (FK → users.id) | Same |
| `repositories` | `ownerId` | TEXT (FK → users.id) | Same |
| `globalMcpServers` | `ownerId` | TEXT (FK → users.id) | Same |
| `runs` | `startedBy` | TEXT (FK → users.id) | Who initiated the run |

**Triggers** do NOT get `ownerId` — they inherit visibility from their parent agent.

### Migration Strategy

Following existing Conduit pattern: `ALTER TABLE ... ADD COLUMN` wrapped in try/catch (idempotent).

- New `ownerId` columns default to `'dev-user'` for existing rows (preserves access in both modes)
- New `startedBy` column on runs defaults to `NULL` for existing rows
- New tables created with `CREATE TABLE IF NOT EXISTS`

---

## 3. Access Control

### Visibility Rule

A user can see an entity if ANY of these conditions are true:

1. **Owner:** `entity.ownerId = currentUser.id`
2. **Direct share:** share exists with `targetType = 'user' AND targetId = currentUser.id`
3. **Group share:** share exists with `targetType = 'group' AND targetId IN currentUser.groupIds`
4. **Everyone:** share exists with `targetType = 'everyone'`

### Core Query Helper

```typescript
// src/main/db/queries/access.ts
function getVisibleEntityIds(
  entityType: 'agent' | 'publishTarget' | 'repository' | 'globalMcpServer',
  userId: string,
  userGroupIds: string[]
): string[]

function canAccessEntity(
  entityType: string,
  entityId: string,
  userId: string,
  userGroupIds: string[]
): boolean
```

### Write Access

Since sharing is full collaboration:
- **Owner** can do anything (edit, delete, share, unshare)
- **Shared users** can edit and run, but cannot delete the entity or modify its shares
- This keeps a clear owner who controls the entity's lifecycle

### Query Pattern Changes

All existing `list*()` functions gain a `userId` parameter:

```typescript
// Before:
function listAgents(): AgentConfig[]

// After:
function listAgents(userId: string, userGroupIds: string[]): AgentConfig[]
```

Implementation: JOIN against `shares` table OR check `ownerId`, filtered by visibility rule.

### Dev Mode Bypass

When auth is disabled:
- `userId` is always `'dev-user'`
- `userGroupIds` is `['everyone']`
- All entities have `ownerId = 'dev-user'`, so owner check always passes
- Result: all entities visible, all operations permitted — identical to current behavior

### WebSocket Handler Context

```typescript
interface RequestContext {
  userId: string
  userGroupIds: string[]
}

// Attached to WebSocket connection after auth
// Passed to all handlers automatically
```

---

## 4. Okta Group Sync

### Sync Mechanism

Groups are synced from the Okta ID token on every login:

1. ID token includes a `groups` claim (must be configured in Okta as a custom claim)
2. On login, server extracts the groups array
3. For each group: upsert into `groups` table
4. Replace `user_groups` entries for this user with current group list
5. Groups no longer in the token for any user are retained (other users may still be in them)

### Hierarchy

- Schema supports hierarchy via `parentGroupId` on the `groups` table
- Initially, all groups are flat (parentGroupId = NULL)
- Future: Okta Management API integration can discover parent/child relationships
- Sharing with a parent group does NOT automatically include child groups (flat evaluation)

### Required Okta Configuration

1. Create an OIDC Web Application in Okta
2. Set grant types: Authorization Code
3. Set redirect URI to `{CONDUIT_URL}/auth/callback`
4. Add a custom claim `groups` to the ID token:
   - Claim type: `groups`
   - Filter: matches regex `.*` (or specific group filter)
   - Include in: ID Token, Always

---

## 5. Sharing API

### New WebSocket Channels

| Channel | Args | Returns | Notes |
|---------|------|---------|-------|
| `shares:list` | `{ entityType, entityId }` | `Share[]` | List all shares for an entity |
| `shares:create` | `{ entityType, entityId, targetType, targetId }` | `Share` | Add a share (owner only) |
| `shares:delete` | `{ shareId }` | `void` | Remove a share (owner only) |
| `users:list` | `{}` | `User[]` | List all users (for share picker) |
| `users:search` | `{ query }` | `User[]` | Search users by name/email |
| `groups:list` | `{}` | `Group[]` | List all groups (for share picker) |

### Share Type

```typescript
interface Share {
  id: string
  entityType: 'agent' | 'publishTarget' | 'repository' | 'globalMcpServer'
  entityId: string
  targetType: 'user' | 'group' | 'everyone'
  targetId: string | null
  createdBy: string
  createdAt: number
}
```

### Broadcast Events

- `share:created` — when a new share is added (notify affected users)
- `share:deleted` — when a share is removed

---

## 6. Frontend Changes

### New Components

**LoginPage** (`src/renderer/components/LoginPage.tsx`)
- Simple page with "Sign in with Okta" button
- Button triggers redirect to `/auth/login`
- Shown when `/auth/me` returns 401

**UserMenu** (`src/renderer/components/UserMenu.tsx`)
- Avatar + name in top-right corner
- Dropdown: user name, email, "Sign Out" action
- Sign out calls `POST /auth/logout` then reloads

**ShareDialog** (`src/renderer/components/ShareDialog.tsx`)
- Modal opened from entity detail views (agent editor, publish target manager, etc.)
- Shows current shares (users + groups)
- Search input to find users/groups to add
- "Share with everyone" toggle
- Remove share button per entry
- Only shown to entity owner

### Modified Components

**AgentList sidebar** — split into sections:
- "My Agents" — agents where `ownerId = currentUser`
- "Shared with Me" — agents shared via user/group/everyone
- Visual indicator (avatar or badge) showing who owns shared agents

**Entity manager modals** (PublishTargets, Repositories, GlobalMcpServers):
- Same "Mine" / "Shared" split
- Share button on each entity (owner only)

**AgentEditor** — share button in header area (owner only)

**RunHistory** — `startedBy` column showing who triggered each run

### Auth Context

```typescript
// src/renderer/contexts/AuthContext.tsx
interface AuthState {
  user: User | null
  groups: Group[]
  isAuthenticated: boolean
  isLoading: boolean
  logout: () => Promise<void>
}
```

- On app load: `GET /auth/me`
  - Success → populate user/groups, render app
  - 401 → show LoginPage
- In dev mode (`/auth/me` returns dev user) → always authenticated

### React Hooks

**`useAuth()`** — access auth context
**`useShares(entityType, entityId)`** — TanStack Query for share list + mutations
**`useUsers()`** — list/search users for share picker
**`useGroups()`** — list groups for share picker

---

## 7. Server Architecture Changes

### Middleware Stack (updated)

```
1. IP restriction (existing)
2. Cookie parser (new)
3. Auth routes (/auth/*) — no session required
4. Session middleware (new) — validates session cookie, attaches user context
5. Static files + SPA fallback (existing)
```

### WebSocket Upgrade (updated)

```
1. IP restriction check (existing)
2. Parse session cookie from upgrade headers (new)
3. Validate session in DB (new)
4. Attach { userId, userGroupIds } to ws connection (new)
5. Complete upgrade
```

### File Organization

New files:
- `src/server/auth/okta.ts` — OIDC client, token exchange, token refresh
- `src/server/auth/session.ts` — session CRUD, cookie handling
- `src/server/auth/middleware.ts` — Express middleware for session validation
- `src/server/auth/devBypass.ts` — dev mode synthetic user
- `src/main/db/queries/users.ts` — user CRUD
- `src/main/db/queries/groups.ts` — group CRUD + user-group sync
- `src/main/db/queries/sessions.ts` — session CRUD
- `src/main/db/queries/shares.ts` — share CRUD + visibility queries
- `src/main/db/queries/access.ts` — visibility helper functions
- `src/renderer/contexts/AuthContext.tsx` — auth React context
- `src/renderer/hooks/useAuth.ts` — auth hook
- `src/renderer/hooks/useShares.ts` — sharing hooks
- `src/renderer/components/LoginPage.tsx`
- `src/renderer/components/UserMenu.tsx`
- `src/renderer/components/ShareDialog.tsx`

Modified files:
- `src/main/db/schema.ts` — new tables + ownerId columns
- `src/main/db/index.ts` — migrations for new tables + columns
- `src/server/index.ts` — middleware stack, WS auth, handler context
- `src/shared/types.ts` — User, Group, Share types, ConduitAPI extensions
- `src/main/db/queries/agents.ts` — add userId filtering
- `src/main/db/queries/publishTargets.ts` — add userId filtering
- `src/main/db/queries/repositories.ts` — add userId filtering
- `src/main/db/queries/globalMcpServers.ts` — add userId filtering
- `src/main/db/queries/runs.ts` — add startedBy, userId filtering
- `src/renderer/App.tsx` — auth wrapper
- `src/renderer/components/AgentList.tsx` — My/Shared sections
- `src/renderer/components/AgentEditor.tsx` — share button
- All entity manager components — ownership awareness

---

## 8. Dependencies

New npm packages:
- `openid-client` — OIDC/OAuth2 client library (token exchange, PKCE, discovery)
- `cookie-parser` — Express cookie parsing middleware

No other external dependencies needed. Session storage uses existing SQLite. PKCE code generation uses Node.js `crypto` built-in.

---

## 9. Verification Plan

### Unit Testing
- Access control: test visibility queries with various ownership/sharing combinations
- Session management: create, validate, expire, refresh
- Group sync: upsert groups, replace memberships
- Share CRUD: create, list, delete, uniqueness constraint

### Integration Testing
- Full OIDC flow with mock Okta server (or Okta developer account)
- WebSocket auth: upgrade with valid/invalid/expired session
- Entity CRUD with ownership: create as user A, verify user B can't see it, share with B, verify access

### Manual Testing
- Dev mode: start server without Okta config → verify current behavior unchanged
- Production mode: configure Okta → complete login flow → verify session cookie → verify entity isolation
- Sharing: create agent → share with group → verify group member can see and edit → unshare → verify removed
- WebSocket reconnect: verify session persists across page reload

### End-to-End Verification
```bash
# Dev mode (no auth)
npm run dev
# → App loads, no login page, all entities visible, behaves identically to today

# Production mode
CONDUIT_OKTA_ISSUER=https://company.okta.com/oauth2/default \
CONDUIT_OKTA_CLIENT_ID=xxx \
CONDUIT_OKTA_CLIENT_SECRET=xxx \
CONDUIT_OKTA_REDIRECT_URI=http://localhost:7456/auth/callback \
CONDUIT_SESSION_SECRET=xxx \
npm run dev
# → Redirects to Okta login → callback → session → app loads with user context
```
