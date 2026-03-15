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
 */

import { createRedisClient } from 'svelte-adapter-uws-extensions/redis'
import { createPubSubBus } from 'svelte-adapter-uws-extensions/redis/pubsub'
import { createRateLimit } from 'svelte-adapter-uws-extensions/redis/ratelimit'
import { createPresence } from 'svelte-adapter-uws-extensions/redis/presence'
import { createCursor } from 'svelte-adapter-uws-extensions/redis/cursor'
import { env } from '$env/dynamic/private'

/** Shared Redis connection. All utilities below share this client. */
export const redis = createRedisClient({ url: env.REDIS_URL })

/** Pub/sub bus for broadcasting events across server instances. */
export const bus = createPubSubBus(redis)

/**
 * Per-user rate limiter: 100 RPC calls per 10 seconds.
 * Throttled RPCs (cursor moves, note drags) are excluded in hooks.ws.js.
 */
export const limiter = createRateLimit(redis, { points: 100, interval: 10000 })

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
	select: (u) => ({ id: u.id, name: u.name, color: u.color })
})

/**
 * Cursor position tracker for live cursor overlays.
 *
 * - throttle: 32ms per-connection -- one user can broadcast their
 *   cursor position at most ~30 times/second
 * - topicThrottle: 16ms per-topic aggregate -- no matter how many
 *   users are on a board, the server broadcasts cursor updates at
 *   most ~60 times/second per board (matching 60fps). Extra updates
 *   are coalesced into a single "bulk" event.
 * - select: same as presence, only expose public user fields
 */
export const cursor = createCursor(redis, {
	throttle: 32,
	topicThrottle: 16,
	select: (u) => ({ id: u.id, name: u.name, color: u.color })
})
