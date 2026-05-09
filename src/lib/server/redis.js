/**
 * Redis-backed infrastructure for the realtime layer.
 *
 * All realtime features (presence, cursors, pub/sub, rate limiting) are
 * backed by Redis so they work across multiple server instances. If you
 * run a single instance, everything still works -- Redis just acts as
 * local state in that case.
 *
 * Each utility is created once at module load and shared across all
 * connections. The adapter hooks (hooks.ws.js) wire them into the
 * WebSocket lifecycle.
 *
 * A circuit breaker wraps all Redis-backed utilities. If Redis goes down
 * (5 consecutive failures), the breaker trips and operations fail fast
 * instead of blocking. When Redis recovers, the breaker resets
 * automatically after 30 seconds.
 */

import { createRedisClient } from 'svelte-adapter-uws-extensions/redis'
import { createPubSubBus } from 'svelte-adapter-uws-extensions/redis/pubsub'
import { createRateLimit } from 'svelte-adapter-uws-extensions/redis/ratelimit'
import { createPresence } from 'svelte-adapter-uws-extensions/redis/presence'
import { createCursor } from 'svelte-adapter-uws-extensions/redis/cursor'
import { createReplay } from 'svelte-adapter-uws-extensions/redis/replay'
import { createConnectionRegistry } from 'svelte-adapter-uws-extensions/redis/registry'
import { createLeader } from 'svelte-adapter-uws-extensions/redis/leader'
import { createCircuitBreaker } from 'svelte-adapter-uws-extensions/breaker'
import { env } from '$env/dynamic/private'
import { metrics } from '$lib/server/metrics'

/** Shared Redis connection. All utilities below share this client. */
export const redis = createRedisClient({ url: env.REDIS_URL })

/**
 * Circuit breaker for Redis. Trips after 5 consecutive failures,
 * probes again after 30 seconds. Presence, cursors, and rate limiting
 * degrade gracefully when Redis is down -- the app stays functional,
 * just without cross-instance features.
 */
export const breaker = createCircuitBreaker({
	failureThreshold: 5,
	resetTimeout: 30000,
	onStateChange: (from, to) => console.log(`[redis breaker] ${from} -> ${to}`)
})

/** Pub/sub bus for broadcasting events across server instances. */
export const bus = createPubSubBus(redis, { breaker })

/**
 * Per-user rate limiter: 100 RPC calls per 10 seconds.
 * Throttled RPCs (cursor moves, note drags) are excluded in hooks.ws.js.
 */
export const limiter = createRateLimit(redis, { points: 100, interval: 10000, breaker })

/**
 * Presence tracker -- who's online globally and per-board.
 *
 * - key: 'id' means we deduplicate by the user's UUID (so multiple
 *   tabs from the same user count as one presence entry)
 * - heartbeat: 30s -- server pings clients every 30 seconds so the
 *   client-side maxAge timer doesn't expire live users
 * - select: only expose id/name/color to other users (not the full
 *   userData which could contain private fields)
 */
export const presence = createPresence(redis, {
	key: 'id',
	heartbeat: 30000,
	select: (u) => ({ id: u.id, name: u.name, color: u.color }),
	breaker
})

/**
 * Cursor position tracker for live cursor overlays.
 *
 * - throttle: 16ms per-connection -- one user can broadcast their
 *   cursor position at most ~60 times/second
 * - topicThrottle: 16ms per-topic world-state tick -- pending positions
 *   per cursor are kept in a Map; every 16ms the server emits one bulk
 *   frame per topic with the latest position for every cursor that
 *   moved. Per-peer wire frames per topic per second = 1000 / 16 = 60,
 *   regardless of cursor count or per-cursor publish rate. Bandwidth
 *   scales with active-mover count, not movers x rate.
 * - select: same as presence, only expose public user fields
 */
export const cursor = createCursor(redis, {
	throttle: 16,
	topicThrottle: 16,
	select: (u) => ({ id: u.id, name: u.name, color: u.color }),
	breaker
})

/**
 * Replay buffer for gap-free reconnect.
 *
 * Captures every publish on whitelisted board topics into a Redis sorted
 * set so a client that drops the WebSocket for a few seconds can present
 * its lastSeenSeqs on reconnect and the server fills the gap silently
 * via __replay:{topic} frames. No initial-fetch flicker.
 *
 * Sized for the demo's per-board churn: 200 events covers a typical
 * editing session within a 1-hour TTL board. ttl=3600 matches the board
 * cleanup cron so replay buffers do not outlive their boards.
 *
 * localFanoutOnStorageFailure: true means dev-without-Redis still
 * delivers events live; only the cluster-wide replay capture is lost
 * when Redis is down. Production with Redis up sees the option as a
 * no-op (no failures, no fallbacks). The
 * replay_storage_fallbacks_total{topic} counter tracks fallback
 * frequency for ops visibility.
 *
 * Captured topics are gated in hooks.ws.js by topic-name regex; this
 * factory has no per-topic knowledge -- it just provides the buffer.
 */
export const replay = createReplay(redis, {
	size: 200,
	ttl: 3600,
	localFanoutOnStorageFailure: true,
	breaker
})

/**
 * Cluster-aware connection registry. Maps userId -> owning instance and
 * exposes a request/reply transport so `live.push({ userId }, ...)` can
 * reach a user on any instance, not just the one their WebSocket is on.
 *
 * Wired in two places:
 * - hooks.ws.js calls `registry.hooks.open` / `.close` to maintain
 *   per-connection registration as users connect and disconnect.
 * - hooks.ws.js calls `live.configurePush({ remoteRegistry: registry })`
 *   so realtime's local pushRegistry miss falls through to
 *   `registry.request(userId, ...)` (cluster hop).
 *
 * Single-instance setups still work with the same wiring -- the local
 * pushRegistry hit short-circuits before the cluster hop, so no Redis
 * round-trip cost. No `attributes` option: the demo only uses
 * `registry.request`, not the attribute-filtered `sendTo`.
 */
export const registry = createConnectionRegistry(redis, {
	identify: (ws) => ws.getUserData()?.id,
	breaker
})

/**
 * Cluster-wide leader-election primitive (extensions next.7+).
 *
 * One worker across the cluster holds the Redis lease at any moment;
 * the synchronous `isLeader()` getter is microsecond-cost. Plugged
 * into realtime via `live.configureCron({ leader: () => leader.isLeader() })`
 * in hooks.ws.js so cron schedules fire once cluster-wide instead of
 * once-per-worker.
 *
 * Single-instance dev: this worker is always the leader (it's the
 * only one), so behavior is identical to no-leader-config. The
 * wiring is production-shaped.
 *
 * Defaults: 30s lease, 10s renew. Fail-closed on errors -- a Redis
 * blip drops `_isLeader` to false and the cron tick skips with a
 * `cron{status:'not-leader'}` metric increment until the next renew
 * succeeds.
 */
export const leader = createLeader(redis, { breaker, metrics })
