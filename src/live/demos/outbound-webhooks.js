// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/outbound-webhooks - the outbound delivery pipeline, end to end.
 *
 * The pitch: `live.webhooks.outbound(sources, config)` fires an HTTP POST
 * to an external endpoint whenever a source topic publishes - no
 * +server.js, no client code, just the declaration. This demo wires the
 * whole production pipeline against an in-app sink endpoint
 * (/api/demos/webhook-sink) so every stage is visible on one page:
 * HMAC-SHA256 signing, the `idempotency-key` header, jittered retries,
 * the dead-letter queue, and replay.
 *
 * Flow: the `placeOrder` RPC publishes a 'placed' event on the orders
 * topic. The outbound webhook (leader-gated via the app-wide
 * `configureCron({ leader })`, so a 4-replica cluster POSTs exactly
 * once) delivers `{ event, data }` to the sink. The sink verifies the
 * signature and LPUSHes a receipt into Redis, which the page polls. An
 * order placed with mode 'fail' makes the sink answer 500, so the
 * delivery exhausts its 3 retries and lands in the cluster-shared
 * Redis DLQ - where the page can inspect it and replay it.
 *
 * The self-target SSRF recipe (documented in the svelte-realtime README):
 * the sink lives on this same host, i.e. loopback - exactly the range
 * the default SSRF guard rightly blocks. Reaching a private/loopback
 * endpoint ON PURPOSE takes the explicit, reviewable pair:
 * - `urlMode: 'off'` relaxes the private/loopback range check (the
 *   http(s) scheme gate stays on, and DNS names are still resolved and
 *   pinned so the target cannot rebind), and
 * - `validateUrl` narrows the allowed set back down to exactly one
 *   path. It is ANDed with the built-in guard on the initial URL and on
 *   every redirect hop, and it can only restrict, never re-open.
 * Without both, delivery to 127.0.0.1 is refused at fire time.
 *
 * Retry/budget/breaker/DLQ are fleet-shared: `configureWebhooks` in
 * src/hooks.ws.js wires the Redis-backed retry budget, endpoint
 * breaker, and dead-letter store, so retries are rationed and failures
 * are visible across every replica, not per-process.
 *
 * Delivery is at-least-once (exactly-once over HTTP is unachievable -
 * a dropped response is indistinguishable from a dropped request), so
 * every POST carries an `idempotency-key` header that is stable across
 * retries and leader-transition double-fires. Here it is the order id,
 * so the sink's receipts make duplicate deliveries visible and
 * dedupable.
 */

import { live, getDeadLetter, replayDeadLetter } from 'svelte-realtime/server'
import { redis } from '$lib/server/redis'
import { TOPICS } from '$lib/server/topics'

const RECEIPTS_KEY = 'demos:outbound:receipts'
const RECEIPTS_MAX = 30
const DLQ_PAGE_LIMIT = 20

/**
 * Shared HMAC secret between the signer (this webhook config) and the
 * verifier (the sink endpoint). Real deployments override with
 * DEMO_OUTBOUND_WEBHOOK_SECRET. The dev fallback is acceptable HERE
 * (unlike /demos/news, which fails closed in production) because the
 * receiving side is our own sink that only logs a receipt - a forged
 * POST to it cannot publish events or mutate application state.
 */
const WEBHOOK_SECRET = process.env.DEMO_OUTBOUND_WEBHOOK_SECRET || 'demo-outbound-secret'

/**
 * Where the sink lives. ORIGIN is set on the production deploy and by
 * the e2e harness's production tier; the PORT fallback covers the local
 * harness's dev-mode instances (which export PORT); the final literal
 * matches Vite's default dev port so a plain `npm run dev` works with
 * zero configuration.
 */
function sinkOrigin() {
	if (process.env.ORIGIN) return process.env.ORIGIN
	const port = process.env.PORT || (process.env.NODE_ENV === 'production' ? '3000' : '5173')
	return `http://127.0.0.1:${port}`
}

/**
 * The outbound webhook. Fires on every publish to the orders topic
 * (leader-gated across the cluster). Body is the default
 * `{ event, data }`; the signature rides `x-webhook-signature` as
 * `sha256=<hex>` over `<x-webhook-timestamp>.<rawBody>`, so the
 * receiver bounds freshness against its own clock.
 */
export const orderEvents = live.webhooks.outbound([TOPICS.demoOutboundOrders], {
	url: () => `${sinkOrigin()}/api/demos/webhook-sink`,
	secret: WEBHOOK_SECRET,
	// Self-target opt-out + narrowing, per the README recipe for
	// deliberately reaching a private/loopback endpoint. See the module
	// JSDoc for why BOTH halves are required.
	urlMode: 'off',
	validateUrl: (u) => {
		try {
			return new URL(u).pathname === '/api/demos/webhook-sink'
		} catch {
			return false
		}
	},
	// Fast demo-scale backoff (defaults are 3 attempts, 100ms..5s): a
	// failing order exhausts ~300+600+1200ms and dead-letters within a
	// few seconds, so the page can show the DLQ filling live.
	retry: { attempts: 3, initialDelayMs: 300, maxDelayMs: 2000 },
	timeoutMs: 5000,
	// Stable across retries AND leader-transition double-fires; the sink
	// records it on every receipt so duplicates are visibly dedupable.
	idempotencyKey: (event, data) => (typeof data?.id === 'string' ? data.id : `${event}:unknown`)
})

/**
 * Place an order. Publishing to the orders topic is all it takes to
 * trigger the outbound delivery. mode 'fail' asks the sink to answer
 * 500, which demonstrates the retry -> DLQ path; anything else is a
 * normal 200 delivery.
 */
export const placeOrder = live(async (ctx, mode) => {
	const order = {
		id: crypto.randomUUID(),
		userId: ctx.user?.id ?? null,
		mode: mode === 'fail' ? 'fail' : 'ok',
		at: Date.now()
	}
	ctx.publish(TOPICS.demoOutboundOrders, 'placed', order)
	return order
})

/**
 * The sink's receipt log, newest first. The sink is a plain HTTP route
 * with no live ctx, so it cannot publish - it only writes Redis. The
 * page keeps this honest by polling this RPC on a short interval while
 * visible instead of pretending the receipts are a push stream.
 */
export const recentReceipts = live(async () => {
	const raws = await redis.redis.lrange(RECEIPTS_KEY, 0, RECEIPTS_MAX - 1)
	const out = []
	for (const raw of raws) {
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt entry */ }
	}
	return out
})

/**
 * Dead-lettered order deliveries (retry-exhausted or gate-blocked),
 * scoped to this demo's topic. Returns a trimmed projection - the full
 * retained payload stays server-side; the page only needs identity,
 * attempts, and the terminal error.
 */
export const deadLetters = live(async () => {
	const store = getDeadLetter()
	if (!store) return []
	const records = await store.list({ topic: TOPICS.demoOutboundOrders, limit: DLQ_PAGE_LIMIT })
	return records.map((r) => ({
		id: r.id,
		event: r.event,
		attempts: r.attempts,
		error: r.error,
		failedAt: r.failedAt,
		orderId: typeof r.data?.id === 'string' ? r.data.id : null,
		mode: r.data?.mode === 'fail' ? 'fail' : 'ok'
	}))
})

/**
 * Replay dead-lettered deliveries through the COMPLETE delivery path -
 * the SSRF gate re-runs at fire time (re-resolving and re-pinning), the
 * signature and idempotency key are recomputed over the ORIGINAL
 * payload, and a successful re-fire removes the record. That original-
 * payload semantics is the point: replaying a mode 'fail' order fails
 * again and returns to the DLQ, exactly as a real receiver that is
 * still down would behave.
 */
export const replayOrders = live(async (ctx, ids) => {
	const scoped = Array.isArray(ids) && ids.length > 0
		? ids.filter((id) => typeof id === 'string').slice(0, DLQ_PAGE_LIMIT)
		: undefined
	return await replayDeadLetter({ ids: scoped, topic: TOPICS.demoOutboundOrders })
})

/**
 * Drop this demo's user content: the receipt log and the retained
 * dead-letter records for the orders topic. Callable from the shared
 * demo-purge orchestrator shape (takes a ctx it does not need).
 */
export async function purge(ctx) {
	const cleared = await redis.redis.del(RECEIPTS_KEY)
	let dropped = 0
	const store = getDeadLetter()
	if (store) {
		const records = await store.list({ topic: TOPICS.demoOutboundOrders, limit: 1000 })
		for (const r of records) {
			try {
				if (await store.remove(r.id)) dropped++
			} catch { /* record already gone */ }
		}
	}
	return { receiptListsCleared: cleared, deadLettersDropped: dropped }
}
