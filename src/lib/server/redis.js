/**
 * Redis-backed infrastructure for the realtime layer.
 *
 * All realtime features (presence, cursors, pub/sub, rate limiting) are
 * backed by Redis so they work across multiple server instances. If you
 * run a single instance, everything still works - Redis just acts as
 * local state in that case.
 *
 * Stateless utilities are created once at module load and shared across all
 * connections. Timer/command-starting utilities stay dormant until the
 * adapter's runtime init hook activates them; Vite's server analysis can
 * therefore import this module without opening Redis sockets.
 *
 * A circuit breaker wraps the realtime Redis utilities. If Redis goes down
 * (5 consecutive failures), the breaker trips and operations fail fast
 * instead of blocking. Identity-session persistence owns a separate breaker
 * so a login/session burst cannot disable presence, cursors, or pub/sub. When
 * Redis recovers, both breakers reset automatically after 30 seconds.
 */

import { createRedisClient } from 'svelte-adapter-uws-extensions/redis'
import { createPubSubBus } from 'svelte-adapter-uws-extensions/redis/pubsub'
import { createRateLimit } from 'svelte-adapter-uws-extensions/redis/ratelimit'
import { createPresence } from 'svelte-adapter-uws-extensions/redis/presence'
import { createCursor } from 'svelte-adapter-uws-extensions/redis/cursor'
import { createReplay } from 'svelte-adapter-uws-extensions/redis/replay'
import { createConnectionRegistry } from 'svelte-adapter-uws-extensions/redis/registry'
import { createLeader } from 'svelte-adapter-uws-extensions/redis/leader'
import { createCrdtCluster } from 'svelte-adapter-uws-extensions/redis/crdt'
import { createSmoothCluster } from 'svelte-adapter-uws-extensions/redis/smooth'
import { createTopicBroadcast } from 'svelte-adapter-uws-extensions/redis/topic-broadcast'
import { createAlarmStore } from 'svelte-adapter-uws-extensions/redis/alarm-store'
import { createDeadLetter } from 'svelte-adapter-uws-extensions/redis/dead-letter'
import { createRetryBudget, createWebhookBreaker } from 'svelte-adapter-uws-extensions/redis/webhook-controls'
import { env } from '$env/dynamic/private'
import { metrics } from '$lib/server/metrics'
import { redisConnectionOptions } from '$lib/server/redis-options'
import { observeRedisCommandRejections } from '$lib/server/redis-command-safety'
import { realtimeBreaker } from '$lib/server/redis-breakers'

/** Shared Redis connection. All utilities below share this client. */
export const redis = createRedisClient({
	url: env.REDIS_URL,
	options: redisConnectionOptions()
})

// Some extension-owned reconnect/timer paths issue commands outside an
// application await boundary. Observe both the primary client and every
// subscriber duplicate so a dropped command Promise cannot terminate the
// worker; normal awaiting callers still receive the rejection unchanged.
observeRedisCommandRejections(redis.redis)
const duplicateRedis = redis.duplicate.bind(redis)
redis.duplicate = (...args) => observeRedisCommandRejections(duplicateRedis(...args))

// Every command path handles its own rejection and reports it to the breaker.
// Keep ioredis from emitting its fallback "Unhandled error event" diagnostic
// while it reconnects in the background.
redis.redis.on('error', () => {})

/**
 * Circuit breaker for Redis. Trips after 5 consecutive failures,
 * probes again after 30 seconds. Presence, cursors, and rate limiting
 * degrade gracefully when Redis is down - the app stays functional,
 * just without cross-instance features.
 */
export const breaker = realtimeBreaker

/** Pub/sub bus for broadcasting events across server instances. */
export const bus = createPubSubBus(redis, { breaker })

/**
 * Per-user rate limiter: 100 RPC calls per 10 seconds.
 * Throttled RPCs (cursor moves, note drags) are excluded in hooks.ws.js.
 */
export const limiter = createRateLimit(redis, { points: 100, interval: 10000, breaker })

/**
 * Presence tracker - who's online globally and per-board.
 *
 * - key: 'id' means we deduplicate by the user's UUID (so multiple
 *   tabs from the same user count as one presence entry)
 * - heartbeat: 30s - server pings clients every 30 seconds so the
 *   client-side maxAge timer doesn't expire live users
 * - select: only expose id/name/color to other users (not the full
 *   userData which could contain private fields)
 */
let presenceInstance = null

function activePresence() {
	if (!presenceInstance) {
		throw new Error('Redis presence used before activateRedisInfrastructure()')
	}
	return presenceInstance
}

/** Dormant presence facade; construction starts its heartbeat timer. */
export const presence = {
	join(...args) { return activePresence().join(...args) },
	leave(...args) { return activePresence().leave(...args) },
	get hooks() { return activePresence().hooks },
	purgeUser(...args) { return activePresence().purgeUser(...args) },
	destroy() { return presenceInstance?.destroy() }
}

/**
 * Cursor position tracker for live cursor overlays.
 *
 * - throttle: 8ms per-connection - one user can broadcast their cursor
 *   at most ~120 times/second, matching a 120Hz display's refresh rate.
 *   Client capture is rAF-driven so it already emits at display-refresh
 *   rate; this gate is the per-connection safety cap.
 * - topicThrottle: 8ms per-topic world-state tick - pending positions
 *   per cursor are kept in a Map; every 8ms the server emits one bulk
 *   frame per topic with the latest position for every cursor that
 *   moved. Per-peer wire frames per topic per second = 1000 / 8 = 120,
 *   regardless of cursor count or per-cursor publish rate. Bandwidth
 *   scales with active-mover count, not movers x rate. The doubled
 *   rate vs 60Hz is the bandwidth cost we accept for visible smoothness
 *   on 120Hz displays. Per-frame size went from "user metadata x N
 *   cursors" to "x, y x N cursors" as of extensions 0.5.2 -- user
 *   metadata now flows on a separate catalog channel (`user-joined`,
 *   `user-updated`, `user-left`), sent on attach + on join/leave only,
 *   not on every flush. So the 120Hz wire cost is dominated by 8 bytes
 *   per cursor per flush, not 100.
 * - snapshotIntervalMs: 100 (extensions 0.5.2 default) - decouples the
 *   Redis HSET writes from the bulk-flush cadence. Cursor positions are
 *   kept in-memory on the publishing replica and only snapshotted to
 *   the durable hash every 100ms (for joiner snapshots + crash
 *   recovery). At 120Hz x N movers that's 10 HSETs/sec per topic instead
 *   of 120 x N. Pre-0.5.2 the demo would saturate Redis writes at a
 *   few hundred concurrent movers; with the snapshot decouple the same
 *   topology survives 10K+.
 * - select: same as presence, only expose public user fields
 */
// Env-tunable throttle / topicThrottle. Defaults stay at the 120Hz
// numbers the demo is tuned for; setting CURSOR_THROTTLE_MS and
// CURSOR_TOPIC_THROTTLE_MS lets operators (or stress runs) rebalance
// without a redeploy. The server-side throttle and the client-side
// CURSOR_INTERVAL_MS must move together to get fair-shape Hz tests --
// at 60Hz client + 8ms server, every incoming RPC crosses the per-
// cursor window and dedup is disabled, producing the pathological
// "every cursor every cycle" dirty map. Keep these matched.
const _cursorThrottleMs = Number.isFinite(parseInt(process.env.CURSOR_THROTTLE_MS, 10))
	? parseInt(process.env.CURSOR_THROTTLE_MS, 10)
	: 8
const _cursorTopicThrottleMs = Number.isFinite(parseInt(process.env.CURSOR_TOPIC_THROTTLE_MS, 10))
	? parseInt(process.env.CURSOR_TOPIC_THROTTLE_MS, 10)
	: 8
export const cursor = createCursor(redis, {
	throttle: _cursorThrottleMs,
	topicThrottle: _cursorTopicThrottleMs,
	snapshotIntervalMs: 100,
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
 * factory has no per-topic knowledge - it just provides the buffer.
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
 * Single-instance setups still work with the same wiring - the local
 * pushRegistry hit short-circuits before the cluster hop, so no Redis
 * round-trip cost. No `attributes` option: the demo only uses
 * `registry.request`, not the attribute-filtered `sendTo`.
 */
let registryInstance = null

function activeRegistry() {
	registryInstance ??= createConnectionRegistry(redis, {
		identify: (ws) => ws.getUserData()?.id,
		breaker
	})
	return registryInstance
}

async function resetFailedRegistry(failed) {
	if (registryInstance !== failed) return
	registryInstance = null
	// Cleanup failure must not mask the original subscribe/open failure.
	await failed.destroy().catch(() => {})
}

/**
 * Stable facade passed to svelte-realtime. The installed registry leaves its
 * subscriber non-null when the first SUBSCRIBE rejects; recreate that private
 * instance so the next connection can recover without a process restart.
 */
export const registry = {
	request(...args) { return activeRegistry().request(...args) },
	lookup(...args) { return activeRegistry().lookup(...args) },
	send(...args) { return activeRegistry().send(...args) },
	sendCoalesced(...args) { return activeRegistry().sendCoalesced(...args) },
	sendTo(...args) { return activeRegistry().sendTo(...args) },
	purgeUser(...args) { return activeRegistry().purgeUser(...args) },
	size() { return registryInstance?.size() ?? 0 },
	hooks: {
		async open(ws, ctx) {
			const current = activeRegistry()
			try {
				await current.hooks.open(ws, ctx)
			} catch (error) {
				await resetFailedRegistry(current)
				throw error
			}
		},
		close(ws, ctx) {
			return registryInstance?.hooks.close(ws, ctx)
		}
	},
	async destroy() {
		const current = registryInstance
		registryInstance = null
		await current?.destroy()
	}
}

/**
 * Cluster-wide leader-election primitive.
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
 * Defaults: 30s lease, 10s renew. Fail-closed on errors - a Redis
 * blip drops `_isLeader` to false and the cron tick skips with a
 * `cron{status:'not-leader'}` metric increment until the next renew
 * succeeds.
 */
let leaderInstance = null

/**
 * 0.6 cluster coordinators + durable stores. Constructed in
 * activateRedisInfrastructure() (their constructors may subscribe or issue
 * commands) and read by hooks.ws init, which attaches the coordinators to
 * the platform (bus.wrap forwards them) and hands the stores to the
 * matching svelte-realtime configure* seams:
 *
 * - crdt: single-writer snapshot persistence + edit relay so live.doc /
 *   live.map / live.array replicas converge across the 4 replicas.
 * - smooth: single-owner-per-topic tick authority for live.smooth; the
 *   non-owning replicas forward commands and re-broadcast frames.
 * - topicBroadcast: scatter-gather transport for cluster-wide
 *   live.push({ topic }) / live.notify({ topic }).
 * - alarmStore: durable live.alarm rows; delete() is the atomic
 *   single-fire claim between the owner's timer and the leader's
 *   recovery poll.
 * - webhookControls: fleet-shared outbound-webhook retry budget +
 *   endpoint ejection + the durable dead-letter queue the admin plane
 *   inspects and replays. DLQ events are stamped with the publishing
 *   user (data.userId) so live.forget can purge them.
 */
let crdtInstance = null
let smoothInstance = null
let topicBroadcastInstance = null
let alarmStoreInstance = null
let webhookControlsInstance = null

export function redisCoordinators() {
	return {
		crdt: crdtInstance,
		smooth: smoothInstance,
		topicBroadcast: topicBroadcastInstance,
		alarmStore: alarmStoreInstance,
		webhookControls: webhookControlsInstance
	}
}

/**
 * Activate utilities whose constructors issue commands or start timers.
 * Called exactly once from hooks.ws init, never during build-time imports.
 */
export function activateRedisInfrastructure() {
	if (!presenceInstance) {
		presenceInstance = createPresence(redis, {
			key: 'id',
			heartbeat: 30000,
			select: (u) => ({ id: u.id, name: u.name, color: u.color }),
			breaker
		})
	}
	if (!leaderInstance) leaderInstance = createLeader(redis, { breaker, metrics })
	crdtInstance ??= createCrdtCluster(redis, { breaker })
	smoothInstance ??= createSmoothCluster(redis, { breaker })
	topicBroadcastInstance ??= createTopicBroadcast(redis, { breaker, metrics })
	alarmStoreInstance ??= createAlarmStore(redis, { breaker, metrics })
	webhookControlsInstance ??= {
		budget: createRetryBudget(redis, { breaker }),
		breaker: createWebhookBreaker(redis, { breaker }),
		deadLetter: createDeadLetter(redis, {
			max: 1000,
			breaker,
			metrics,
			forgetUserId: (record) => record?.data?.userId ?? null
		})
	}
}

/** Destroy the 0.6 coordinators (worker shutdown). Best-effort, idempotent. */
export async function destroyRedisCoordinators() {
	const doomed = [crdtInstance, smoothInstance, topicBroadcastInstance, alarmStoreInstance, webhookControlsInstance?.breaker]
	crdtInstance = null
	smoothInstance = null
	topicBroadcastInstance = null
	alarmStoreInstance = null
	webhookControlsInstance = null
	await Promise.allSettled(doomed.map((instance) => instance?.destroy?.()))
}

/** Dormant, fail-closed leader facade for modules imported during analysis. */
export const leader = {
	isLeader() { return leaderInstance?.isLeader() ?? false },
	currentLeader() { return leaderInstance?.currentLeader() ?? Promise.resolve(null) },
	stop() { return leaderInstance?.stop() ?? Promise.resolve() },
	get instanceId() { return leaderInstance?.instanceId ?? null },
	get key() { return leaderInstance?.key ?? null }
}
