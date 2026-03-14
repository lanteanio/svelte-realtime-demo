# svelte-realtime-demo

A collaborative sticky notes wall built with [svelte-realtime](https://github.com/lanteanio/svelte-realtime), [svelte-adapter-uws](https://github.com/lanteanio/svelte-adapter-uws), and [svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions).

Open the page, get a random funny name, drop sticky notes on a shared canvas. Every note, cursor movement, and color change syncs in real time across all connected browsers. No login, no auth, no friction.

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
| Rate limiting | extensions | Throttle note creation to prevent spam (drag moves are excluded from the global limit) |
| Presence | extensions | Colored dots showing who's on each board |
| Cursors | extensions | Live cursor positions on the spatial canvas |

---

## Tech stack

- **Frontend** -- SvelteKit, Svelte 5, Tailwind CSS v4, DaisyUI v5
- **Server** -- svelte-adapter-uws
- **Realtime** -- svelte-realtime
- **Extensions** -- svelte-adapter-uws-extensions (Redis + Postgres)
- **Database** -- PostgreSQL (production) / in-memory Map (dev)
- **Cache & pub/sub** -- Redis (production) / not needed (dev)

---

## Getting started

### Prerequisites

- Node.js >= 20
- Docker (for Postgres and Redis, or bring your own)

### Install dependencies

```bash
npm install
```

The three core packages (`svelte-adapter-uws`, `svelte-realtime`, `svelte-adapter-uws-extensions`) are linked from sibling directories via `file:` references in `package.json`. No npm registry needed.

### Configure environment

Copy the example env file and adjust the values for your setup:

```bash
cp .env.example .env
```

The defaults point at `localhost` which works if Postgres and Redis are running in Docker on standard ports. Vite loads `.env` automatically -- no dotenv package needed.

### Run in dev mode

```bash
npm run dev
```

If `DATABASE_URL` is set, the app uses Postgres. If not, it falls back to an in-memory Map store so you can develop without Docker.

### Create the database tables

```bash
psql $DATABASE_URL -f schema.sql
```

### Build for production

```bash
npm run build
node build
```

The `.env` file is loaded by Vite during dev. In production, set real environment variables on your host or container.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | _(none)_ | Postgres connection string. When unset, the app uses an in-memory Map store. |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string for pub/sub, presence, cursors, and rate limiting. |
| `HOST` | `0.0.0.0` | Server bind address. |
| `PORT` | `3000` | Server port. |
| `CLUSTER_WORKERS` | _(none)_ | Set to `auto` for multi-core clustering. |

---

## Project structure

```
src/
├── hooks.ws.js                     -- WebSocket hooks (identity, Redis bus, rate limiting, presence, cursors)
├── routes/
│   ├── +layout.svelte              -- Navbar with identity + connection status + theme toggle
│   ├── +layout.server.js           -- Read identity cookie, pass to client
│   ├── +page.svelte                -- Board list with live presence counts
│   └── board/[slug]/
│       ├── +page.svelte            -- Canvas view (notes, presence, cursors, activity, undo)
│       └── +page.server.js         -- Resolve slug to board_id via DB
├── lib/
│   ├── names.js                    -- Random name + color + slug generator
│   ├── server/
│   │   ├── db.js                   -- Pure SQL via pg driver (in-memory Map fallback for dev)
│   │   └── validate.js             -- Input validation and bounds checking for all user-controlled fields
│   └── components/
│       ├── StickyNote.svelte       -- Draggable note with color picker + z-ordering
│       ├── Canvas.svelte           -- Scrollable canvas container + cursor tracking
│       ├── PresenceBar.svelte      -- Online user dots + names
│       ├── CursorOverlay.svelte    -- SVG layer with labeled cursors
│       ├── ActivityTicker.svelte   -- Fixed bottom bar with recent actions
│       ├── BoardHeader.svelte      -- Board title + background color picker
│       └── BoardCard.svelte        -- Board list item with live presence count
└── live/
    ├── boards.js                   -- Board CRUD + board list stream
    └── boards/
        ├── notes.js                -- Note CRUD + notes stream (crud merge)
        ├── activity.js             -- Activity feed stream (latest merge, ephemeral)
        └── settings.js             -- Board settings stream (set merge)
```

---

## Database

Two tables. No users, no sessions, no board_members. Identity lives in a cookie. Activity is ephemeral.

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
    is_archived  boolean      DEFAULT FALSE NOT NULL,
    created_at   timestamptz  DEFAULT now() NOT NULL
);
```

The full schema including the auto-archive trigger is in `schema.sql`.

---

## How identity works

No login screen. Every new connection gets a random two-word name (like "Cosmic Penguin") and a random color, persisted in a cookie. Same tab, new tab, page reload -- you keep your name. New incognito window -- fresh name.

The identity cookie is validated on both the WebSocket upgrade path and the HTTP layout load. Only cookies with a valid UUID, a name between 1-40 characters, and a hex color are accepted. Malformed or tampered cookies are discarded and a fresh identity is generated.

900 possible combinations (30 adjectives x 30 nouns). Collisions don't matter for a demo.

---

## License

MIT
