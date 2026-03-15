# svelte-realtime-demo

A collaborative sticky notes wall built with [svelte-realtime](https://github.com/lanteanio/svelte-realtime), [svelte-adapter-uws](https://github.com/lanteanio/svelte-adapter-uws), and [svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions).

Open the page, get a random funny name, drop sticky notes on a shared canvas. Every note, cursor movement, and color change syncs in real time across all connected browsers. No login, no auth, no friction.

**Try it now:** [svelte-realtime-demo.lantean.io](https://svelte-realtime-demo.lantean.io/) -- open it in two tabs and watch the magic. No account needed.

---

## What it demonstrates

| Feature | Package | How it's used |
|---|---|---|
| `live()` RPC | svelte-realtime | Create, update, delete, and move notes |
| `live.stream()` crud merge | svelte-realtime | Notes on the canvas -- real-time CRUD |
| `live.stream()` set merge | svelte-realtime | Board settings (title, background color) |
| `live.stream()` latest merge | svelte-realtime | Activity ticker -- ephemeral ring buffer |
| `batch()` | svelte-realtime | Coalesce rapid note-drag moves into single WebSocket frames |
| Optimistic updates | svelte-realtime | Note position updates instantly on drag, server confirms async |
| Undo / redo | svelte-realtime | Ctrl+Z / Ctrl+Shift+Z to undo note actions |
| `status` store | svelte-adapter-uws | Connection status dot in navbar (green/yellow/red) |
| Redis pub/sub bus | extensions | Multi-instance deployment with cross-instance updates |
| Input validation | server | Board titles, note content, colors, and coordinates are validated and bounded |
| Rate limiting | extensions | 100 RPCs per 10 seconds per user (drag/cursor moves are excluded) |
| Presence | extensions | Who's online globally and on each board, with heartbeat + maxAge cleanup |
| Cursors | extensions | Live cursor overlay with per-topic throttle (~60 broadcasts/sec) |
| Canvas rendering | demo | 1000 cursors at 60fps via Canvas 2D with bitmap label caching |
| Batch SQL | demo | FAB actions (tidy, rearrange, shuffle, group) use a single query via `unnest()` |

---

## Performance

Stress-tested with 1000 simultaneous bot users on a single board, all moving cursors at 20 updates/second each.

| Metric | Result |
|---|---|
| Connections | 1000/1000 (100%) |
| Connect time | ~8 seconds |
| FPS (1000 cursors) | 60 |
| p50 frame time | 16.7ms |
| p95 frame time | 18.0ms |
| JS heap | 9.5 MB |
| Server responsive | Yes (no degradation under load) |

Key optimizations:
- **Canvas 2D** instead of SVG for cursors (zero DOM diffing per frame)
- **Bitmap label cache** -- each user's name is rendered to an offscreen canvas once, then `drawImage()` per frame
- **rAF cursor throttle** -- outbound cursor moves coalesced to one per animation frame
- **Per-topic broadcast budget** -- server caps cursor broadcasts at ~60/sec per board regardless of user count
- **RAF event batching** -- incoming WebSocket events coalesced into one Svelte store update per frame
- **Batch SQL** -- arrangement actions update all notes in a single `unnest()` query instead of N+1

---

## Tech stack

- **Frontend** -- SvelteKit, Svelte 5 (runes), Tailwind CSS v4, DaisyUI v5
- **Server** -- svelte-adapter-uws (uWebSockets.js)
- **Realtime** -- svelte-realtime (RPC + live streams over WebSocket)
- **Extensions** -- svelte-adapter-uws-extensions (Redis-backed presence, cursors, pub/sub, rate limiting)
- **Database** -- PostgreSQL (production) / in-memory Map (dev)
- **Cache & pub/sub** -- Redis (production) / not needed (dev)

---

## Getting started

### Prerequisites

- Node.js >= 20
- Docker (for Postgres and Redis, or bring your own)

### Install

```bash
npm install
```

### Configure

Copy the example env file:

```bash
cp .env.example .env
```

The defaults point at `localhost` which works if Postgres and Redis are running in Docker on standard ports. Vite loads `.env` automatically.

### Create the database

```bash
psql $DATABASE_URL -f schema.sql
```

### Dev mode

```bash
npm run dev
```

If `DATABASE_URL` is not set, the app falls back to an in-memory store. You can develop without Postgres or Redis -- all realtime features still work locally, just not across multiple server instances.

### Production build

```bash
npm run build
npm start
```

### Deploy with Docker Compose

The included `docker-compose.yml` sets up everything you need: app, Postgres, Redis, and a certbot container that automatically obtains and renews a Let's Encrypt TLS certificate. You get HTTPS out of the box.

The app runs as 2 independent replicas using `network_mode: host` and `SO_REUSEPORT`. The Linux kernel distributes incoming connections across both processes. Redis handles cross-process pub/sub. No load balancer needed.

1. Point a domain at your server (A record)
2. Create a `.env` file:

```bash
DOMAIN=your-domain.com
POSTGRES_PASSWORD=pick-a-strong-password
```

3. Get the initial certificate:

```bash
docker compose run --rm certbot certonly --standalone -d your-domain.com
```

4. Start everything:

```bash
docker compose up -d
```

The app listens on port 443 directly (host networking). Certbot renews the certificate automatically every 12 hours. Postgres and Redis data are persisted in Docker volumes.

To scale to more replicas (if your machine has more cores):

```bash
docker compose up -d --scale app=4
```

---

## E2E tests

103 Playwright tests covering:

- Board CRUD, note operations (create, edit, drag, delete, color, z-order)
- Board settings (title, background), persistence across refresh
- FAB menu (tidy, rearrange by color, shuffle, group by author)
- Undo/redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, textarea guard)
- Multi-user realtime sync (two browser contexts)
- Presence and cursor overlay
- Activity ticker
- Identity system and theme toggle
- Input validation (empty/long titles, XSS, invalid slugs)
- WebSocket connection leak detection
- Performance metrics (TTFB, FCP, CLS, resource sizes)
- 1000-user cursor stress test

```bash
# Run everything
npm run test:e2e

# Run without the stress test (faster)
npx playwright test --grep-invert "Stress"

# Run only the stress test
npx playwright test e2e/stress.spec.js
```

Tests run against the deployed instance at `https://svelte-realtime-demo.lantean.io`. To test against a different URL, change `baseURL` in `playwright.config.js`.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | _(none)_ | Postgres connection string. When unset, uses in-memory store. |
| `REDIS_URL` | `redis://localhost:6379` | Redis for pub/sub, presence, cursors, and rate limiting. |
| `HOST` | `0.0.0.0` | Server bind address. |
| `PORT` | `3000` | Server port. |
| `CLUSTER_WORKERS` | _(none)_ | Set to `auto` for multi-core clustering. |

---

## Project structure

```
src/
├── hooks.ws.js                     -- WebSocket lifecycle (identity, bus, rate limit, presence, cursors)
├── hooks.server.js                 -- SvelteKit error handler
├── app.css                         -- Tailwind + DaisyUI setup
├── routes/
│   ├── +layout.svelte              -- Navbar: identity, connection status, note color, theme toggle
│   ├── +layout.server.js           -- Identity cookie: read or generate
│   ├── +page.svelte                -- Home: board list + create form
│   └── board/[slug]/
│       ├── +page.svelte            -- Board: canvas, notes, FAB, undo/redo, rate limit toast
│       └── +page.server.js         -- Resolve slug -> board_id
├── lib/
│   ├── names.js                    -- Random name/color/slug generator
│   ├── server/
│   │   ├── db.js                   -- Postgres + in-memory fallback (batch updates via unnest)
│   │   ├── validate.js             -- Input validation for all RPCs (UUID, bounds, allowlist)
│   │   └── redis.js                -- Redis client, pub/sub bus, rate limiter, presence, cursors
│   └── components/
│       ├── StickyNote.svelte       -- Draggable note: edit, color, delete, z-order
│       ├── Canvas.svelte           -- Board area: pointer tracking with rAF throttle
│       ├── CursorOverlay.svelte    -- Canvas 2D cursor rendering with bitmap label cache
│       ├── PresenceBar.svelte      -- Avatars with maxAge cleanup (capped at 8 + overflow)
│       ├── ActivityTicker.svelte   -- Bottom bar: 5 most recent actions
│       ├── BoardHeader.svelte      -- Inline title edit + background color picker
│       └── BoardCard.svelte        -- Board list item with live presence badge
└── live/
    ├── boards.js                   -- Board CRUD + board list stream
    └── boards/
        ├── notes.js                -- Note CRUD + batch arrangement actions + notes stream
        ├── activity.js             -- Activity feed stream (ephemeral, latest merge)
        ├── settings.js             -- Board settings stream (set merge)
        └── cursors.js              -- Presence join/leave + cursor movement RPCs
```

---

## Database

Two tables. No users table, no sessions, no board_members. Identity lives in a cookie. Activity is ephemeral (not stored).

```sql
CREATE TABLE board (
    board_id     uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
    title        text         NOT NULL,
    slug         text         NOT NULL UNIQUE,
    background   text         DEFAULT '#f5f5f4' NOT NULL,
    created_at   timestamptz  DEFAULT now() NOT NULL
);

CREATE TABLE note (
    note_id      uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
    board_id     uuid         NOT NULL REFERENCES board (board_id) ON DELETE CASCADE,
    content      text         DEFAULT '' NOT NULL,
    x            integer      DEFAULT 200 NOT NULL,
    y            integer      DEFAULT 200 NOT NULL,
    color        text         DEFAULT '#fef08a' NOT NULL,
    creator_name text         NOT NULL,
    z_index      integer      DEFAULT 0 NOT NULL,
    is_archived  boolean      DEFAULT FALSE NOT NULL,
    created_at   timestamptz  DEFAULT now() NOT NULL
);
```

The full schema including indexes and the auto-archive trigger is in `schema.sql`.

---

## How identity works

No login. Every new visitor gets a random two-word name (like "Cosmic Penguin") and a random color, stored in a cookie. Same tab, new tab, page reload -- same identity. New incognito window -- fresh identity.

The cookie is validated on both the WebSocket upgrade path (`hooks.ws.js`) and the HTTP layout load (`+layout.server.js`). Only cookies with a valid UUID, a name between 1-40 characters, and a valid hex color are accepted. Anything else triggers a fresh identity.

900 possible name combinations (30 adjectives x 30 nouns). Collisions are harmless -- names are for display only, the UUID is what matters.

---

## How realtime works

1. Client opens the page -- SvelteKit renders HTML server-side
2. Client JS boots -- WebSocket connects automatically via `svelte-adapter-uws`
3. Client subscribes to live streams (`notes`, `settings`, `activity`) -- gets initial data + real-time events
4. User does something (creates a note, drags, edits) -- calls a `live()` RPC over WebSocket
5. Server validates input, writes to Postgres, publishes an event to the topic
6. All clients subscribed to that topic receive the event and update their local store
7. Svelte reactivity re-renders the changed parts of the UI

Cursors work differently -- they bypass the database entirely. Cursor positions go through Redis pub/sub for cross-instance delivery and are rendered on a Canvas 2D overlay for performance.

---

## License

MIT
