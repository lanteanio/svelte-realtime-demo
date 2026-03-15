# Svelte Realtime Demo

A collaborative sticky notes app built with [svelte-realtime](https://github.com/lanteanio/svelte-realtime), [svelte-adapter-uws](https://github.com/lanteanio/svelte-adapter-uws), and [svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions).

Open the page, get a random name, drop notes on a shared canvas. Every note, cursor, and color change syncs across all browsers in real time. No login, no friction.

**Try it now:** [svelte-realtime-demo.lantean.io](https://svelte-realtime-demo.lantean.io/) -- open two tabs and watch the magic. Runs on a Hetzner CPX22 (2 shared vCPUs, 4 GB RAM, 6.49/month).

**Source:** [github.com/lanteanio/svelte-realtime-demo](https://github.com/lanteanio/svelte-realtime-demo)

---

## What it demonstrates

| Feature | Package | How it's used |
|---|---|---|
| `live()` RPC | svelte-realtime | Create, update, delete, and move notes |
| `live.stream()` crud merge | svelte-realtime | Notes on the canvas -- real-time CRUD |
| `live.stream()` set merge | svelte-realtime | Board settings (title, background color) |
| `live.stream()` latest merge | svelte-realtime | Activity ticker -- ephemeral ring buffer |
| `live.cron()` | svelte-realtime | Board cleanup -- delete stale boards every minute |
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
| Board TTL | demo | Boards auto-delete after 1 hour of inactivity, with live countdown timer |
| Mobile support | demo | Touch dragging, responsive navbar, controls visible without hover |

---

## Board lifecycle

Boards are ephemeral by design. Every board starts with a 1-hour countdown. Any meaningful action (create/edit/delete a note, change settings, run an arrangement) resets the timer. Boards with no activity for 1 hour are deleted automatically by a server-side cron job.

The `stress-me-out` board is exempt -- it's auto-created on startup and never expires. The E2E stress tests use it.

Countdown timers are visible on every board card (home page) and in the board header. They use the DaisyUI countdown component and change color as the deadline approaches: neutral > 10 min, warning 5-10 min, error < 5 min.

---

## Performance

Stress-tested with 1000 simultaneous bot users on a single board, all moving cursors.

| Metric | Result |
|---|---|
| Connections | 1000/1000 (100%) |
| Connect time | ~8 seconds |
| FPS (1000 cursors) | 60 |
| p50 frame time | 16.7ms |
| p95 frame time | 18.0ms |
| JS heap | 9.5 MB |
| Server responsive | Yes |

Key optimizations:
- **Canvas 2D** instead of SVG for cursors (zero DOM diffing per frame)
- **Bitmap label cache** -- user names rendered to offscreen canvases once, then `drawImage()` per frame
- **rAF cursor throttle** -- outbound cursor moves coalesced to one per animation frame
- **Per-topic broadcast budget** -- server caps cursor broadcasts at ~60/sec per board regardless of user count
- **RAF event batching** -- incoming WebSocket events coalesced into one Svelte store update per frame
- **Batch SQL** -- arrangement actions update all notes in a single `unnest()` query instead of N+1
- **Direct DOM drag** -- note dragging bypasses Svelte reactivity during the drag for smooth touch performance
- **Delayed handoff** -- local drag position held for 300ms after release to avoid snap-back jitter

For OS-level tuning (sysctl, ulimits, conntrack), see the [svelte-adapter-uws production docs](https://github.com/lanteanio/svelte-adapter-uws#os-tuning-for-production).

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

The defaults point at `localhost` which works if Postgres and Redis are running in Docker on standard ports.

### Create the database

```bash
psql $DATABASE_URL -f schema.sql
```

The `last_activity` column is auto-migrated on startup if missing.

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

The included `docker-compose.yml` sets up everything: app, Postgres, Redis, and a certbot container for automatic Let's Encrypt TLS. HTTPS out of the box, no reverse proxy.

The app runs as 2 independent replicas using `network_mode: host` and `SO_REUSEPORT`. The Linux kernel distributes incoming connections across both processes. Redis handles cross-process pub/sub.

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

The app listens on port 443 directly (host networking). Certbot renews automatically every 12 hours. Postgres and Redis data are persisted in Docker volumes.

To scale replicas:

```bash
docker compose up -d --scale app=4
```

---

## E2E tests

Playwright tests covering:

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
- Mobile touch (drag, double-tap create, controls visible, responsive nav)
- 1000-user cursor stress test
- Presence-only destroyer (ramp to 10K, find the connection ceiling)
- Cursor destroyer (ramp with live cursor movement)

```bash
# Run everything
npm run test:e2e

# Run without the stress/destroyer tests (faster)
npx playwright test --grep-invert "Stress|Destroyer"

# Run only the stress test
npx playwright test e2e/stress.spec.js

# Run the destroyer from the server (bypass NAT limits)
node e2e/destroyer-standalone.js
node e2e/destroyer-standalone.js --cursors
```

Tests run against `https://svelte-realtime-demo.lantean.io`. Change `baseURL` in `playwright.config.js` to test elsewhere.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | _(none)_ | Postgres connection string. When unset, uses in-memory store. |
| `REDIS_URL` | `redis://localhost:6379` | Redis for pub/sub, presence, cursors, and rate limiting. |
| `HOST` | `0.0.0.0` | Server bind address. |
| `PORT` | `3000` | Server port. |

---

## Project structure

```
src/
├── hooks.ws.js                     -- WebSocket lifecycle (identity, presence, cursors)
├── hooks.server.js                 -- DB migration, stress board, error handler
├── app.html                        -- HTML shell with Svelte favicon
├── app.css                         -- Tailwind + DaisyUI setup
├── routes/
│   ├── +layout.svelte              -- Navbar: identity, online count, colors, GitHub, theme
│   ├── +layout.server.js           -- Identity cookie: read or generate
│   ├── +page.svelte                -- Home: board list + create form + TTL hint
│   └── board/[slug]/
│       ├── +page.svelte            -- Board: canvas, notes, FAB, undo/redo, rate limit toast
│       └── +page.server.js         -- Resolve slug -> board_id
├── lib/
│   ├── names.js                    -- Random name/color/slug generator
│   ├── server/
│   │   ├── db.js                   -- Postgres + in-memory (touch, delete, stale cleanup)
│   │   ├── validate.js             -- Input validation (UUID, bounds, allowlist)
│   │   └── redis.js                -- Redis client, pub/sub, rate limiter, presence, cursors
│   └── components/
│       ├── StickyNote.svelte       -- Draggable note: edit, color, delete, z-order, touch
│       ├── Canvas.svelte           -- Board area: pointer tracking with rAF throttle
│       ├── CursorOverlay.svelte    -- Canvas 2D cursor rendering with bitmap label cache
│       ├── PresenceBar.svelte      -- Avatars with maxAge (8 desktop, 1 mobile, +N overflow)
│       ├── ActivityTicker.svelte   -- Bottom bar: 5 most recent actions
│       ├── BoardHeader.svelte      -- Title edit + background picker + TTL countdown
│       ├── BoardCard.svelte        -- Board list item with presence badge + countdown
│       └── CountdownTimer.svelte   -- DaisyUI countdown with color urgency
└── live/
    ├── boards.js                   -- Board CRUD + stream + cleanup cron (1h TTL)
    └── boards/
        ├── notes.js                -- Note CRUD + batch arrangements + board touch
        ├── activity.js             -- Activity feed (ephemeral, latest merge)
        ├── settings.js             -- Board settings (set merge)
        └── cursors.js              -- Presence join/leave + cursor movement
```

---

## Database

Two tables. No users, no sessions. Identity lives in a cookie. Activity is ephemeral.

```sql
CREATE TABLE board (
    board_id       uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
    title          text         NOT NULL,
    slug           text         NOT NULL UNIQUE,
    background     text         DEFAULT '#f5f5f4' NOT NULL,
    last_activity  timestamptz  DEFAULT now() NOT NULL,
    created_at     timestamptz  DEFAULT now() NOT NULL
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

Full schema including indexes and auto-archive trigger in `schema.sql`.

---

## How identity works

No login. Every visitor gets a random two-word name (like "Cosmic Penguin") and a random color, stored in a cookie. Same tab, new tab, page reload -- same identity. New incognito window -- fresh identity.

The cookie is validated on both the WebSocket upgrade path (`hooks.ws.js`) and the HTTP layout load (`+layout.server.js`). Only cookies with a valid UUID, a name between 1-40 characters, and a valid hex color are accepted.

900 possible name combinations (30 adjectives x 30 nouns). Collisions are harmless -- names are for display only, the UUID is what matters.

---

## How realtime works

1. Client opens the page -- SvelteKit renders HTML server-side
2. Client JS boots -- WebSocket connects via `svelte-adapter-uws`
3. Client subscribes to live streams (`notes`, `settings`, `activity`) -- gets initial data + events
4. User does something (creates a note, drags, edits) -- calls a `live()` RPC over WebSocket
5. Server validates input, writes to Postgres, publishes an event to the topic
6. All subscribed clients receive the event and update their local store
7. Svelte reactivity re-renders the changed parts of the UI

Cursors bypass the database. Positions go through Redis pub/sub and are rendered on a Canvas 2D overlay.

Board cleanup runs as a `live.cron()` job every minute. It queries for boards where `last_activity` is older than 1 hour, deletes them, and publishes `deleted` events so all home page viewers see the board disappear.

---

## License

MIT
