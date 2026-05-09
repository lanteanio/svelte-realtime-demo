/**
 * /demos/checkout -- idempotency under double-click.
 *
 * The pitch: rapid double-clicks (or flaky-reconnect retries) on the
 * same intent fire N RPCs, but only ONE side effect happens. The
 * server returns the cached result for every retry within ttl.
 *
 * Mechanism: live.idempotent({ ttl: 60 }) wraps the placeOrder RPC.
 * The client supplies an idempotencyKey per intent (one UUID per
 * "I want to place an order" decision, reused across retries).
 * Identical keys within the ttl window return the cached result
 * without re-running the handler.
 *
 * Counter is in-memory (demo only -- not durable across restarts).
 */

import { live } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

let orderCount = 0

export const placeOrder = live.idempotent({ ttl: 60 }, async (ctx) => {
	orderCount += 1
	const result = { count: orderCount, ts: Date.now() }
	ctx.publish(TOPICS.demoCheckoutCount, 'set', orderCount)
	return result
})

export const count = live.stream(TOPICS.demoCheckoutCount, async () => {
	return orderCount
}, { merge: 'set' })

export const reset = live(async (ctx) => {
	orderCount = 0
	ctx.publish(TOPICS.demoCheckoutCount, 'set', 0)
	return { count: 0 }
})
