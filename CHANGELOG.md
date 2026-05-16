# Changelog

All notable changes to `svelte-realtime-demo` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Security

- **App connects to Postgres as the non-superuser `stickynotes_app` role.** Pre-fix, the demo's `DATABASE_URL` connected as `postgres` - the superuser bootstrap role created by the official postgres image. An RCE landing inside the node container had full DDL / role-management / cross-database access from the connection it already held. Fix: a new `init-app-role.sh` runs once on first postgres init (via `/docker-entrypoint-initdb.d/00-init-app-role.sh`) and creates the `stickynotes_app` role with the password from `STICKYNOTES_APP_PASSWORD`. `schema.sql` runs a `SET ROLE stickynotes_app` block so the `board` / `note` tables, the `note_board_id_idx` index, and the `archive_old_notes()` function are all owned by `stickynotes_app`. Owner privilege lets the runtime `ALTER TABLE` in `hooks.server.js` continue to work without granting the app role broader rights. The role is NOT a superuser (`rolsuper=f`), cannot create other roles (`rolcreaterole=f`), cannot create databases (`rolcreatedb=f`), and has no privilege on databases other than `stickynotes`. The `postgres` superuser password (`POSTGRES_PASSWORD`) is still required for the image's first-init bootstrap and for operator ad-hoc maintenance (`docker exec -it <container> psql -U postgres`), just not for the app's runtime connection.

  **Operator action required (existing deployments).** docker-entrypoint-initdb.d only runs on fresh volume init, so existing deployments must create the role manually and transfer table ownership ONCE before redeploying:

  ```bash
  # 1. Set STICKYNOTES_APP_PASSWORD in .env (a fresh 32-char random string is fine).
  # 2. Run this from the existing deployment host:
  docker compose exec postgres psql -U postgres -d stickynotes <<'SQL'
    CREATE ROLE stickynotes_app WITH LOGIN PASSWORD 'paste-STICKYNOTES_APP_PASSWORD-here';
    GRANT USAGE, CREATE ON SCHEMA public TO stickynotes_app;
    ALTER TABLE board OWNER TO stickynotes_app;
    ALTER TABLE note OWNER TO stickynotes_app;
    ALTER FUNCTION archive_old_notes() OWNER TO stickynotes_app;
  SQL
  # 3. docker compose up -d (recreates the app container with the new DATABASE_URL).
  ```

  Fresh deployments (operators wiping the data volume or starting from scratch) get the role created automatically by the init script - no manual step needed.

- **Identity moved from a JSON cookie to a server-side session keyed by an opaque cookie-id.** Pre-fix, the identity cookie was plain JSON; the `/demos/denials` org ACL is keyed off `userData.org` which derives from this cookie, so any browser-side attacker who controls their own cookie can switch orgs at will. Considered HMAC-signing the payload (and shipped a prototype), then refactored to the canonical session-store pattern: the cookie is now a 128-bit opaque base64url session-id (~22 chars), and the actual identity (`id`, `name`, `color`, `org`) lives in Redis under `identity-session:<id>` as a hash with a 30-day sliding TTL. Forgery requires guessing a 128-bit random id (computationally infeasible). Compared to HMAC, this pattern gains: trivial per-user revocation (`DEL identity-session:<id>`), trivial field mutation (`HSET identity-session:<id> org globex` for the org-switch endpoint), and no long-lived shared secret to rotate or distribute across replicas. New module `$lib/server/identity-session` exports `lookupSession`, `createSession`, `updateSessionField`, plus `tryParseLegacyJsonCookie` for one-shot migration of pre-this-change visitors (their displayed name carries over). Wired through `+layout.server.js`, `hooks.ws.js`, `api/demos/set-org/+server.js`. The `COOKIE_SECRET` env var added in the earlier iteration is removed - the new pattern needs no secret. svelte-check passes with zero errors.

- **`/metrics` endpoint gated by `METRICS_SCRAPE_TOKEN` when set.** Pre-fix, the metrics endpoint was always reachable. Fix: when the env var is set, the handler requires a matching `X-Scrape-Token` header and 401s otherwise. When unset (default), the endpoint stays open - no behavior change for existing deployments. The endpoint's own comment already recommended gating; this implements it. `.env.example` documents the option.

- **Webhook secret fails closed in production.** `src/live/demos/news.js` previously fell back to a hardcoded `'demo-news-secret'` string when `DEMO_NEWS_WEBHOOK_SECRET` was unset, including in production - so the secret used to verify HMAC-signed webhook events was a value checked into the repo. Fix: the fallback now throws at module load when `NODE_ENV === 'production'`. Dev keeps the same fallback so a fresh checkout works without env setup.

- **Postgres bound to `127.0.0.1`.** Pre-fix, `docker-compose.yml` exposed Postgres on `5432:5432` (= `0.0.0.0:5432` on the host); operators with permissive host firewalls had a direct DB connection surface from any peer. Fix: port mapping changed to `127.0.0.1:5432:5432`. The app continues to reach Postgres via the docker bridge network (DNS name `postgres:5432`, see the network refactor below). External `psql -h <host>` from another machine is now blocked; operators run `docker compose exec postgres psql ...` or open a sidecar tunnel when DB access from the host machine is needed. Mirrors the docs repo's pre-existing 127.0.0.1 bind.

- **App container no longer uses `network_mode: host`.** Pre-fix, the app shared the host's network namespace and connected to redis/postgres at `127.0.0.1:6379` / `:5432` (the host's loopback). This works but couples the app to the host's network stack and conflicts with the localhost-bind changes (the loopback `127.0.0.1:6379` mapping on the redis service was bypassed by host networking - the app was hitting redis via the host's docker-proxy port mapping anyway). Fix: drop `network_mode: host`, publish port 443 explicitly via `"443:3443"` (container listens on 3443 as the non-root `node` user; docker-proxy handles the host-side 443 binding), and resolve redis/postgres via the docker bridge network's embedded DNS (`redis:6379`, `postgres:5432`). **Operator action required**: this is a coordinated networking change. Verify in staging that TLS handshake completes on https://your-domain before deploying to production. Cert volume mount (read-only at `/etc/letsencrypt`) is unchanged. Performance: one extra docker-proxy hop on inbound TLS, negligible for WebSocket/SSE-shaped workloads.

- **App container runs as the unprivileged `node` user.** Pre-fix, the demo's Dockerfile had no `USER` directive, so the app ran as root inside the container - giving any RCE inside node access to the full container's filesystem and capabilities. Fix: install `gosu`, copy a new `entrypoint.sh` that (a) copies the Let's Encrypt privkey (mode 0600 root) into a node-readable location and rewrites the SSL_CERT/SSL_KEY env vars to point at the copy, (b) execs `gosu node node build` to drop privileges before the app starts. Mirrors the docs repo's pattern. The image's port stays at 3443 (non-privileged) so no `cap_net_bind_service` is needed; docker-proxy handles the host:443 binding. **Operator action**: ensure your deployment workflow runs `docker compose build` to rebuild the image with the new entrypoint; the running container needs replacement.

### Changed

- **Identity cookie now has explicit `secure: !dev` and `sameSite: 'lax'`.** Previously the `cookies.set('identity', ...)` calls in `+layout.server.js` and `api/demos/set-org/+server.js` set `path` / `maxAge` / `httpOnly` but relied on SvelteKit defaults for `secure` and `sameSite`. SvelteKit's defaults are reasonable but explicit beats implicit; this future-proofs against a SvelteKit default-flip and makes the intent visible at the call site. `secure: !dev` means cookies require HTTPS in production but are allowed over HTTP in dev mode where the dev server runs at localhost.

- **`build.sourcemap: false` set explicitly in `vite.config.js`.** Vite's default depends on env/mode and could swap to `true` under a debug build path. Pinning to `false` prevents a future config drift from leaking server-source maps into the production bundle.

- **Docker base images pinned by digest.** `node:22-trixie-slim`, `postgres:17-alpine`, and `redis:7-alpine` in `Dockerfile`, `Dockerfile.postgres`, and `docker-compose.yml` are now suffixed with `@sha256:<digest>` so reproducible rebuilds cannot accidentally pull in a re-tagged base image. Bump the digests manually when the operator decides to pull in upstream security fixes; the existing `docker compose build` does not auto-resolve to newer image versions once pinned.

- **Production image installs only runtime dependencies.** Pre-fix, the production stage copied `node_modules` from the build stage, carrying every devDep (vite, svelte-check, playwright, etc.) into the runtime image. Fix: the production stage now runs `npm ci --omit=dev` directly against the same `package-lock.json`, then copies only the build artifacts (`/app/build`). Net result: a smaller image, zero devDeps shipped, and no chance of a future test/build tool getting executed at runtime. The build stage still installs full deps (it needs vite to build).

- **Redis bound to `127.0.0.1` and supports optional `REDIS_PASSWORD` AUTH.** Pre-fix, `docker-compose.yml` ran redis with `--protected-mode no` AND port mapping `6379:6379` (= `0.0.0.0:6379` on the host), making the cache directly reachable from any peer with network access to the host. The audit's 4.1 concern was real for deployments where the host firewall doesn't block 6379. Fix: (a) port mapping changed to `127.0.0.1:6379:6379` so only the host can reach redis, (b) `--protected-mode no` dropped (no longer needed, and keeping the default fail-closed posture is a defense layer for future misconfigurations), (c) the redis service's `command` now branches on `REDIS_PASSWORD`: when set, starts with `--requirepass`; when unset, starts unauthenticated (preserves existing-deployment behavior - no operator action required at upgrade time). The app's `REDIS_URL` mirrors with `redis://:${REDIS_PASSWORD:-}@127.0.0.1:6379`. Healthcheck also adapts. `.env.example` documents the option. Operators wanting AUTH set `REDIS_PASSWORD` in `.env` and recompose. Existing deployments without the variable keep working unchanged but now without the public 6379 surface.

- **`POST /api/demos/set-org` rejects cross-origin requests at the application layer.** SvelteKit's built-in CSRF check (in 2.59.x and earlier) fires only on form-content-types: `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`, and SvelteKit's binary-form type. JSON POSTs are skipped by intent - the framework relies on browser CORS preflight + the `sameSite: lax` cookie attribute to defend cross-site CSRF for JSON. Both layers already protect this endpoint in practice (the identity cookie is sameSite: lax; no permissive CORS headers are set), but a future cookie-attr regression (sameSite: none) or a non-browser client bypassing CORS would reopen the gap. Defense-in-depth: the handler now reads `request.headers.get('origin')` and errors 403 if non-null and non-matching `url.origin`. Same-origin requests (the only legitimate use of this endpoint - the `/demos/denials` org-picker) continue to work unchanged.

- **`.gitignore` now excludes `*.pem`, `*.key`, `*.crt`, `*.pfx`, `*.p12`.** Pre-fix, only `.env*` was ignored - so Let's Encrypt artifacts (`fullchain.pem`, `privkey.pem`, `cert.pem`), self-signed dev certs from `init-certs.sh`, and Windows certificate bundles (`.pfx`, `.p12`) would slip into a commit on `git add .` from the wrong terminal. None are currently tracked (verified via `git ls-files | grep -iE '\.(pem|key|crt|pfx|p12)$'`), so the change is preventative rather than remediating - no historical commits need scrubbing. The same patterns landed in the docs repo's `.gitignore` under the same date.

- **`e2e/destroyer-standalone.js` no longer disables TLS verification process-wide.** Pre-fix, the script set `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` at module load, which disables certificate verification for EVERY subsequent TLS handshake in the process - not just the destroyer's own fetch calls. The WebSocket open at line ~50 already used a scoped `rejectUnauthorized: false` per connection; the global mutation was the remaining bypass. A future maintainer adding a fetch to a third-party endpoint (a metrics push, a webhook callback, anything) would unknowingly skip cert verification on that endpoint because the global toggle was still set. Fix: import `Agent` from `undici` (Node's bundled HTTP client; added as devDependency so the Agent class is reachable via public ESM import), construct a single `insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } })` for this script's two `fetch` calls (`getBoardId` and `checkServer`), and remove the global env mutation. Each fetch now passes `{ dispatcher: insecureDispatcher }`. The destroyer's behavior against self-signed certs is unchanged; what changed is that the bypass is now bounded to the two endpoints the destroyer actually hits.

### Changed

- **All six top-level shell scripts (`deploy.sh`, `init-certs.sh`, `renew-certs.sh`, `reset-all.sh`, `reset-db.sh`, `reset-redis.sh`) switched from `set -e` to `set -euo pipefail`.** Plain `set -e` catches only direct command failures in straight-line code; it misses (a) failures in the left side of a pipeline (the `false | tee` shape - the script proceeds even though the upstream errored) and (b) unset-variable references (a typo like `$DOAMIN` silently expands to empty string and feeds the empty string into `docker compose exec`). `set -u` (nounset) makes the typo error out; `pipefail` propagates pipeline failures. Audited each script for compatibility before flipping: the only scripts that read environment vars are the reset trio (`${CONFIRM:-}` is `set -u`-safe) and `init-certs.sh` (`${1:?...}` / `${2:?...}` are also `set -u`-safe by design). Pure `docker compose` driver scripts with no variable reads inherit the safer semantics for free.

### Security

- **`reset-all.sh`, `reset-db.sh`, `reset-redis.sh` now require `CONFIRM=yes` to run.** Pre-fix, anyone with `docker exec` access (or shell access to the operator's checkout) was one `./reset-all.sh` away from `TRUNCATE note, board CASCADE` plus `redis-cli FLUSHALL` against the running demo. A muscle-memory `./reset-` followed by a tab-complete in the wrong terminal pane would wipe production demo state with no second prompt. The scripts now check `[ "${CONFIRM:-}" != "yes" ]` before any destructive command and exit 1 with a usage hint; the new invocation is `CONFIRM=yes ./reset-all.sh` (or `./reset-db.sh`, `./reset-redis.sh`). The guard fires before `cd "$(dirname "$0")"` so even a script invoked from the wrong directory cannot proceed accidentally.

- **`reset-*.sh` excluded from the prod Docker image via `.dockerignore`.** Pre-fix, the scripts shipped inside the container at the workdir root (no `.dockerignore` rule excluded them) and were reachable via `docker exec demo-app bash /app/reset-all.sh`. Even with the new `CONFIRM=yes` guard at the script level, the principle is that operator tooling for tearing down dev data has no business being inside a production image - so the scripts are now stripped at build time by adding `reset-*.sh` to `.dockerignore`. Operators run them from the host checkout (where the scripts still live and the guard still applies).

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
