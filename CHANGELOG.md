# Changelog

All notable changes to `svelte-realtime-demo` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.4.0] - 2026-03-20

Aligns with svelte-adapter-uws 0.4.0, svelte-adapter-uws-extensions 0.4.0, and svelte-realtime 0.4.0.

### Breaking Changes

- **`hooks.ws.js` must export an `unsubscribe` hook.** Required by svelte-realtime 0.4.0. Without it, presence and cursor cleanup only happens on socket close, not on topic drop. Our implementation delegates to `presence.hooks.unsubscribe()`.
- **`close` hook signature changed.** The adapter now passes `{ platform, subscriptions }` instead of just `{ platform }`. Our hook now forwards the full context object to `presence.hooks.close()` and `cursor.hooks.close()` instead of destructuring.
- **Removed bare `export { presence, cursor }` from `hooks.ws.js`.** These module-level re-exports did nothing. All hook wiring is now explicit through named hook functions.
- **`cursor.remove(ws, platform)` replaced with `cursor.hooks.close(ws, ctx)`.** The extensions 0.4.0 cursor plugin exposes a `hooks` helper. Direct `.remove()` calls are replaced with the hooks pattern.
- **Dependency versions bumped.** `svelte-adapter-uws` from ^0.3.8 to ^0.4.0, `svelte-adapter-uws-extensions` from ^0.1.9 to ^0.4.0, `svelte-realtime` from ^0.1.7 to ^0.4.0. All three must be upgraded together.

### Added

- **`unsubscribe` hook** in `hooks.ws.js`. Fires the moment a client drops a topic (page navigation, stream teardown). Cleans up presence for that topic immediately instead of waiting for the socket to close. Users disappear from board presence bars the instant they navigate away.
- **Cursor snapshot on subscribe.** `cursor.hooks.subscribe()` is now called in the `subscribe` hook. When a user joins a board, they receive the current cursor positions of everyone already on that board instead of waiting for the next movement from each user.
- **Circuit breaker for Redis** via `createCircuitBreaker()` from `svelte-adapter-uws-extensions/breaker`. Wraps presence, cursors, pub/sub bus, and rate limiting. After 5 consecutive Redis failures, the breaker trips and operations fail fast. Probes again after 30 seconds. The app stays functional without Redis, just without cross-instance features. State changes are logged to the console.
- **`ctx.batch()` for arrangement actions.** Tidy, rearrange, shuffle, and group-by-author now publish all note updates plus the activity event in a single `ctx.batch()` call. Reduces Redis pub/sub round trips from N+1 to 1 when running multiple replicas.
- **`ctx.batch()` for cleanup cron.** Stale board deletions are published in a single batch instead of one-by-one.
- **Postgres advisory lock on cleanup cron.** With multiple replicas, only one acquires `pg_try_advisory_lock(900001)` and runs the cleanup. The others skip the tick. Prevents duplicate deletes and duplicate event broadcasts.
- **`tryAdvisoryLock()` and `advisoryUnlock()` in `db.js`.** Non-blocking advisory lock helpers. Return `true` immediately in dev mode (no Postgres) so crons run normally without a database.
- **Input validation guard for update payloads.** `validateBoardFields()` and `validateNoteFields()` now reject `null`, strings, arrays, and other non-object values with a clean `VALIDATION` error instead of throwing a raw TypeError.
- **First-load hint in dev mode.** A Vite plugin logs `[demo] First page load compiles all modules on demand -- expect 5-10 seconds. Subsequent loads are instant.` at server start so developers know to expect a slow first render.
- **Docker Compose runs 2 app replicas** again (was temporarily set to 1). Exercises the Redis pub/sub bus and advisory lock in production.

### Fixed

- **Startup race between migration and `ensureBoard`.** Previously, the `ALTER TABLE` migration and `ensureBoard('stress-me-out')` fired concurrently. If `ensureBoard` hit the database before the migration finished, it would fail with "column last_activity does not exist". Migration now completes before `ensureBoard` runs.
- **Dead migration code removed.** The `UPDATE board SET last_activity = created_at WHERE last_activity = created_at` query after the ALTER TABLE was a leftover from the initial backfill. It was a no-op since the column already existed with `DEFAULT now()`.
- **`moveCursor` called with undefined boardId.** The Canvas component could fire `moveCursor(undefined, pos)` if a pointer event fired before `boardId` resolved from route data. Added a `!boardId` guard in `flushCursor()`.
- **Stale E2E assertions.** `e2e/home.spec.js` expected "Sticky Notes" but the UI says "Svelte Realtime Demo". `e2e/board.spec.js` navigated home by clicking "Sticky Notes" text, now uses `a[href="/"]` which works regardless of viewport size.

### Under the Hood

- All arrangement actions (tidy, rearrange, shuffle, group-by-author) produce the same events in the same order. The only change is that they are sent as a single batch frame instead of N+1 individual publishes. No client-side changes needed.
- The `close` hook now delegates to `presence.hooks.close()` and `cursor.hooks.close()` instead of calling `presence.hooks.close()` and `cursor.remove()` separately. Same behavior, uses the standardized hooks pattern from extensions 0.4.0.
- The `subscribe` hook now calls both `presence.hooks.subscribe()` and `cursor.hooks.subscribe()`. Previously only presence was wired up. The cursor hook is a no-op for non-cursor topics.
- The circuit breaker has zero overhead when Redis is healthy. It only changes behavior after 5 consecutive failures.
- The advisory lock uses `pg_try_advisory_lock` (non-blocking). If the lock is held by another replica, the cron returns immediately without querying for stale boards.
- The `assertPlainObject` guard runs before any field access in `validateBoardFields` and `validateNoteFields`. No performance impact on valid payloads.
- Package version bumped from 0.0.3 to 0.4.0 to align with the upstream stack.

---

## [0.0.3] - 2026-03-17

### Added

- Sort boards by online user count on the home page (most active first)
- Fix drag snap-back after note release

## [0.0.2] - 2026-03-16

### Added

- Mobile optimizations (touch drag, responsive navbar, double-tap create)

## [0.0.1] - 2026-03-15

### Added

- Initial release: collaborative sticky notes with real-time sync
- Board CRUD with 1-hour TTL and automatic cleanup
- Note operations (create, edit, drag, delete, color, z-order)
- Undo/redo with history tracking
- Presence tracking (global and per-board)
- Live cursor overlay with Canvas 2D rendering
- Activity ticker (ephemeral, latest merge)
- Board settings (title, background color)
- FAB menu (tidy, rearrange by color, shuffle, group by author)
- Batch SQL for arrangement actions
- Rate limiting (100 RPCs / 10s, drag/cursor excluded)
- Identity system (random name + color, cookie-based)
- Redis-backed pub/sub for multi-instance deployment
- PostgreSQL + in-memory dual database implementation
- E2E test suite (Playwright)
- Docker Compose deployment with certbot TLS
- 1000-cursor stress test
