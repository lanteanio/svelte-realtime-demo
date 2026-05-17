/**
 * /demos/checkout - idempotency under double-click.
 *
 * The pitch: rapid double-clicks (or flaky-reconnect retries) on the
 * same intent fire N RPCs, but only ONE side effect happens. The
 * server returns the cached result for every retry within ttl.
 *
 * Mechanism: live.idempotent({ ttl: 60, store }) wraps the placeOrder
 * RPC with a cluster-shared Redis-backed idempotency store. The client
 * supplies an idempotencyKey per intent (one UUID per "I want to place
 * an order" decision, reused across retries). Identical keys within the
 * ttl window return the cached result without re-running the handler -
 * even when retries land on different replicas, because the store is
 * cluster-shared (Redis SETNX), not per-instance.
 *
 * Counter lives in Redis (INCR) so the value is consistent across
 * replicas; reset uses SET so multi-replica deploys reset to a single
 * known state.
 */

import { live } from 'svelte-realtime/server'
import { createIdempotencyStore } from 'svelte-adapter-uws-extensions/redis/idempotency'
import { TOPICS } from '$lib/server/topics'
import { redis, breaker } from '$lib/server/redis'
import { metrics } from '$lib/server/metrics'

const COUNT_KEY = 'demos:checkout:count'

/**
 * Cluster-shared idempotency store. Without this, a user's double-click
 * with retries hitting two different replicas would run the handler
 * twice (each replica's in-process default cache is independent) and
 * the counter would jump by 2 instead of 1 - defeating the demo's
 * pitch the moment two replicas exist.
 */
const idempotencyStore = createIdempotencyStore(redis, {
	keyPrefix: 'demos:checkout:idemp:',
	ttl: 60,
	acquireTtl: 30,
	breaker,
	metrics
})

export const placeOrder = live.idempotent({ ttl: 60, store: idempotencyStore }, async (ctx) => {
	const count = await redis.redis.incr(COUNT_KEY)
	const result = { count, ts: Date.now() }
	ctx.publish(TOPICS.demoCheckoutCount, 'set', count)
	return result
})

export const count = live.stream(TOPICS.demoCheckoutCount, async () => {
	const v = await redis.redis.get(COUNT_KEY)
	return v === null ? 0 : Number(v)
}, { merge: 'set' })

export const reset = live(async (ctx) => {
	await redis.redis.set(COUNT_KEY, 0)
	ctx.publish(TOPICS.demoCheckoutCount, 'set', 0)
	return { count: 0 }
})
