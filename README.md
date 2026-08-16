# Svelte Realtime Demo

A collaborative sticky notes app built with [svelte-realtime](https://github.com/lanteanio/svelte-realtime), [svelte-adapter-uws](https://github.com/lanteanio/svelte-adapter-uws), and [svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions).

**Official links:** [GitHub owner](https://github.com/lanteanio) | [Documentation](https://svelte-realtime.dev/) | [Live demo](https://svelte-realtime-demo.lantean.io/) | `svti.me` is the ecosystem-owned runtime-help redirect domain.

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
| `ctx.batch()` | svelte-realtime | Server-side batched publish for arrangement actions and cron cleanup |
| Optimistic updates | svelte-realtime | Note position updates instantly on drag, server confirms async |
| Undo / redo | svelte-realtime | Ctrl+Z / Ctrl+Shift+Z to undo note actions |
| `status` store | svelte-adapter-uws | Connection status dot in navbar (green/yellow/red) |
| Redis pub/sub bus | extensions | Multi-instance deployment with cross-instance updates |
| Input validation | server | Board titles, note content, colors, and coordinates are validated and bounded |
| Rate limiting | extensions | 100 RPCs per 10 seconds per user (drag/cursor moves are excluded) |
| Presence | extensions | Who's online globally and on each board, with heartbeat + maxAge cleanup |
| Cursors | extensions | Live cursor overlay with per-topic throttle (~60 broadcasts/sec) |
| Cursor snapshots | extensions | Joining users instantly see existing cursor positions |
| Circuit breaker | extensions | Redis failures degrade gracefully instead of blocking |
| Real-time unsubscribe | adapter 0.4.0 | Presence and cursors clean up immediately on page navigation |
| Canvas rendering | demo | 1000 cursors at 60fps via Canvas 2D with bitmap label caching |
| Batch SQL | demo | FAB actions (tidy, rearrange, shuffle, group) use a single query via `unnest()` |
| Board TTL | demo | Boards auto-delete after 1 hour of inactivity, with live countdown timer |
| Mobile support | demo | Touch dragging, responsive navbar, controls visible without hover |

The table above covers the sticky-notes board. Beyond it, the app ships a
gallery of focused demo pages, one per framework primitive.

---

## Demo gallery

Every page lives at `/demos/<slug>`, backed by one module in
`src/live/demos/` and one Playwright spec in `test/e2e/`.

| Route | What it shows |
|---|---|
| `checkout` | Idempotency under a retry storm |
| `counter-resume` | Reconnect-resume with no flicker |
| `chat` | Chat rooms with presence + denials |
| `todos-rollback` | Optimistic mutate with rollback |
| `denials` | Subscribe denials with org switcher |
| `pressure` | Admission-shedding control panel |
| `chaos` | Deterministic chaos (seeded drop rate) |
| `notifications` | Push, reply, schedule |
| `topk` | Top-K leaderboards: four windows, one config |
| `news` | Cron + windowed aggregate + derived + inbound webhook |
| `jobs` | Durable task runner with fence + retry |
| `cluster-cron` | Leader election: one leader, one tick |
| `upload` | Streaming uploads with content-addressed dedup |
| `auctions` | Deadline-bounded bid race over live.push |
| `schema-evolution` | Subscribe-time migrate hooks |
| `flash-sales` | Atomic inventory under contention (live.lock) |
| `pagination` | Cursor-based load-more with live merges |
| `effect` | Server-side reactive side effects |
| `from-seq` | Three-tier reconnect gap fill |
| `collab-editor` | CRDT-anchored selections vs raw offsets |
| `multiplayer` | Full-surface room: cursors, locks, typing, reactions |
| `kanban` | Shared CRDT document, zero RPC handlers |
| `offline` | Offline queue: post now, sync later, replay once |
| `arena` | Area-of-interest culling with LOD bands |
| `shooter` | Lag-compensated hit testing |
| `lobbies` | Room browser, ownership, share codes |
| `tenants` | Strict per-connection tenant isolation |
| `flags` | Feature flags: flip once, everywhere |
| `alarms` | Durable one-shot timers that survive restarts |
| `forget` | Right to erasure: one call, every surface |
| `privacy` | k-anonymity + differential privacy aggregates |
| `ops` | The introspection dashboard |
| `outbound-webhooks` | Sign, retry, dead-letter, replay |
| `phases` | Attach lifecycle + atomic publish batch |

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
- **Batched publish** -- arrangement actions publish all note updates + activity in a single `ctx.batch()` call instead of N+1 individual publishes
- **Batch SQL** -- arrangement actions update all notes in a single `unnest()` query instead of N+1
- **Direct DOM drag** -- note dragging bypasses Svelte reactivity during the drag for smooth touch performance
- **Delayed handoff** -- local drag position held for 300ms after release to avoid snap-back jitter

For OS-level tuning (sysctl, ulimits, conntrack), see the [svelte-adapter-uws production docs](https://github.com/lanteanio/svelte-adapter-uws#os-tuning-for-production).

---

## Tech stack

- **Frontend** -- SvelteKit, Svelte 5 (runes), Tailwind CSS v4, DaisyUI v5
- **Server** -- svelte-adapter-uws (uWebSockets.js)
- **Realtime** -- svelte-realtime (RPC + live streams over WebSocket)
- **Extensions** -- svelte-adapter-uws-extensions (Redis-backed presence, cursors, pub/sub, rate limiting, circuit breaker)
- **Database** -- PostgreSQL (production) / in-memory Map (dev)
- **Cache & pub/sub** -- Redis (production) / not needed (dev)

---

## Getting started

### Prerequisites

- Node.js 22.19+ (the highest direct-dependency floor, enforced by
  `package.json` and exercised in CI)
- Docker (for Postgres and Redis, or bring your own)

### Install

```bash
npm ci
```

### Configure

Copy the example env file:

```bash
cp .env.example .env
```

The defaults point at `localhost` which works if Postgres and Redis are running in Docker on standard ports.

### Create or upgrade the database

The same checksummed migration path handles an empty database and every
upgrade. Run it before starting a new application revision:

```bash
npm run migrate
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

The included `docker-compose.yml` sets up everything: app, Postgres, Redis, and a certbot container for automatic Let's Encrypt TLS. HTTPS out of the box, no reverse proxy.

The app runs as 4 independent replicas by default using `network_mode: host`
and `SO_REUSEPORT`. The Linux kernel distributes incoming connections across
the processes. Redis handles cross-process pub/sub.

1. Point a domain at your server (A record)
2. Create a `.env` file:

```bash
DOMAIN=your-domain.com
POSTGRES_PASSWORD=pick-a-strong-password
STICKYNOTES_APP_PASSWORD=pick-a-different-strong-password
DEMO_NEWS_WEBHOOK_SECRET=generate-a-long-random-secret
```

3. Get the initial certificate. The explicit entrypoint is required because
   the long-running certbot service itself uses a shell renewal loop:

```bash
docker compose run --rm --entrypoint certbot -p 80:80 certbot certonly --standalone -d your-domain.com
```

4. Start everything:

```bash
docker compose up -d
```

The `migrate` service completes before any app replica is allowed to start.
The app listens on port 443 directly (host networking). Certbot checks for
renewals every 12 hours. Running replicas fingerprint the read-only source
certificate and key; after a renewed pair is stable, they restart gracefully
with independent jitter and copy the new material before accepting traffic.
Postgres and Redis data are persisted in Docker volumes.

For production updates, use `./scripts/deploy.sh`. It requires a clean checkout, builds
an image tagged with the exact Git revision, runs migrations, waits for every
replica's dependency-aware `/healthz` check, verifies the public page and
WebSocket upgrade, and restores the previous image automatically if readiness
or smoke verification fails.

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
- One spec per demo page (every entry in the demo gallery above)
- 1000-user cursor stress test
- Presence-only destroyer (ramp to 10K, find the connection ceiling)
- Cursor destroyer (ramp with live cursor movement)

```bash
# Everyday verification: static checks, unit tests, build, then safe E2E
npm test

# Individual E2E tiers (each provisions isolated Postgres/Redis + local app)
npm run test:e2e:isolated
npm run test:e2e:cluster
npm run test:e2e:stress
npm run test:e2e:diagnostics
npm run test:e2e:destroyer

# Explicit expensive ladder: safe + cluster + stress + 10K destroyer
# Continues through failures and prints an aggregate result.
npm run test:all
```

The normal target is always a dynamically allocated loopback port. Assertion-free `_*.spec.js` probes run only in the explicit diagnostics project. To point a low-level Playwright command at a remote test environment, set both `BASE_URL` and `ALLOW_REMOTE_E2E=1`; without that opt-in the configuration refuses any non-loopback host. Never enable the opt-in for production.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | _(none)_ | Postgres connection string. When unset, uses in-memory store. |
| `DATABASE_POOL_MAX` | `10` | Maximum shared PostgreSQL connections per app process (4 replicas = at most 40). |
| `DATABASE_CONNECT_TIMEOUT_MS` | `2000` | Bounded PostgreSQL connection wait. |
| `REDIS_URL` | `redis://localhost:6379` | Redis for pub/sub, presence, cursors, and rate limiting. |
| `REDIS_SESSION_TIMEOUT_MS` | `1000` | Per-operation identity-session budget before ephemeral fallback. |
| `READINESS_TIMEOUT_MS` | `2500` | Per-dependency readiness budget. |
| `ADMIN_TOKEN` | _(none)_ | Bearer token for the `/__realtime/*` admin plane (introspect, DLQ inspect + replay, lifeline metrics). Unset = every admin request is denied. |
| `DEMO_NEWS_WEBHOOK_SECRET` | _(dev fallback)_ | HMAC secret for the inbound newsroom webhook. Required in production. |
| `HOST` | `0.0.0.0` | Server bind address. |
| `PORT` | `3000` | Server port. |
| `ORIGIN` | _(none)_ | The deployment's canonical public origin, e.g. `https://example.com`. When set it is the authority for WebSocket admission: a handshake whose `Origin` does not match is refused with 403, a handshake carrying no `Origin` is refused with 401, and a request whose `Host` is neither this name nor a loopback name is refused with 400. Unset (a bare checkout) leaves all three inert. The compose file derives it from `DOMAIN`. |
| `ALLOWED_ORIGINS` | _(none)_ | **Build-time.** Comma-separated extra origins for a deployment reachable under more than one name, e.g. `https://example.com,https://www.example.com`. Read when the bundle is built, not when the container starts. A single-hostname deployment leaves this unset and relies on `ORIGIN`. |
| `WS_ALLOW_ORIGINLESS` | _(none)_ | Set to `1` to re-admit WebSocket handshakes that carry no `Origin` header on a deployment that has `ORIGIN` set. Browsers always send `Origin`, so this is only for non-browser clients. |
| `BUILD_OUT_DIR` | `build` | **Build-time.** Where the built server is written. The e2e harness sets it per run so a concurrent build in the same checkout cannot rewrite the tree a live run is serving from; deployments leave it alone. |

---

## Project structure

```
scripts/                            -- build, migrate, deploy, cert + reset helpers, test runners
migrations/                         -- ordered, checksummed SQL (see Database)
test/
├── e2e/                            -- Playwright specs: board app + one per demo page
└── unit/                           -- unit tests (run via scripts/run-unit.mjs)
src/
├── hooks.ws.js                     -- WebSocket lifecycle: identity, presence, cursors,
│                                      tenant resolver, admin plane, coordinator wiring
├── hooks.server.js                 -- Stress-board bootstrap, Host check, framing header,
│                                      error handler
├── app.html                        -- HTML shell with Svelte favicon
├── app.css                         -- Tailwind + DaisyUI setup
├── routes/
│   ├── +layout.svelte              -- Navbar, connection status, 'outdated bundle' reload banner
│   ├── +layout.server.js           -- Identity cookie: read or generate
│   ├── +page.svelte                -- Home: board list + searchable demo catalog
│   ├── board/[slug]/               -- The sticky-notes board (canvas, FAB, undo/redo)
│   ├── demos/                      -- One page per demo, shared sidebar layout
│   ├── api/demos/                  -- Webhook sink + inbound news webhook + org/tenant switchers
│   ├── healthz/                    -- Dependency-aware health (readiness is the adapter's /readyz)
│   └── metrics/                    -- Prometheus-style metrics
├── lib/
│   ├── names.js                    -- Random name/color/slug generator
│   ├── configure-app.js            -- App-wide realtime client options, merged under page options
│   ├── protocol-version.js         -- Shared wire/contract version (server + client)
│   ├── server/
│   │   ├── db.js                   -- Postgres + in-memory (touch, delete, stale cleanup)
│   │   ├── redis.js                -- Redis client, pub/sub bus, coordinators (CRDT, smooth,
│   │   │                              alarms, dead-letter, webhook controls), presence, breaker
│   │   ├── topics.js               -- Topic registry: single source of truth for every topic
│   │   ├── demo-purge.js           -- Cron purge of demo user-content
│   │   ├── tasks.js                -- Durable task runner (jobs demo)
│   │   ├── validate.js             -- Input validation (UUID, bounds, allowlist)
│   │   └── ...                     -- identity sessions, readiness, metrics, upload staging
│   └── components/                 -- Board UI (StickyNote, Canvas, CursorOverlay, ...)
└── live/
    ├── boards.js + boards/         -- Board CRUD, notes, activity, settings, cursors
    └── demos/                      -- One module per demo page; game demos add pure
                                       .shared.js sim modules shared client/server
```

---

## Admin plane and probes

- `/healthz` is the app's dependency-aware health check (Postgres, Redis,
  identity store). The adapter's built-in health route is disabled
  (`healthCheckPath: false` in `svelte.config.js`) so it cannot shadow it.
- `/readyz` is the adapter's readiness probe; deploys and compose
  healthchecks gate on it.
- `/__realtime/*` is the fail-closed admin plane (introspect snapshot, DLQ
  inspect + replay, lifeline metrics). Requests need `Authorization: Bearer
  $ADMIN_TOKEN`; with `ADMIN_TOKEN` unset every request is denied. The
  `/demos/ops` page renders the same introspect snapshot over the socket.

---

## Database

The canonical schema is the ordered, checksummed SQL under `migrations/`.
It contains the `board` and `note` application tables, the durable jobs-demo
tables, validation-mirroring constraints, measured query indexes, and the
auto-archive function. `scripts/migrate.mjs` serializes migration runners and
records applied checksums in `schema_migration`.

---

## How identity works

No login. Every visitor gets a random two-word name (like "Cosmic Penguin")
and a random color. An opaque 128-bit session id is held in a `Secure`,
`SameSite=Lax`, `HttpOnly` cookie; the identity itself lives in Redis with a
30-day sliding TTL. Browsers attach the cookie to HTTP and WebSocket upgrades
without exposing the bearer token to client JavaScript. If Redis is down, a
request gets a bounded ephemeral identity fallback rather than hanging.

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
