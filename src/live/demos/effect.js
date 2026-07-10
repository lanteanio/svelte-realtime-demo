// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/effect: server-side reactive side effects via live.effect.
 *
 * The pitch. The user clicks "Place order"; the RPC publishes
 * 'created' on the orders topic and returns. A separately-registered
 * `live.effect(['orders'], handler)` fires, receives the event +
 * data + platform reference, and fans out to two adjacent topics:
 * an audit log and a user notifications feed. Three streams light
 * up from one user action, proving the side-effect plumbing.
 *
 * The headline primitive: `live.effect(sources, handler)` -
 * fire-and-forget server-side reaction to topic publishes. No
 * return value, no derived stream; just a hook that runs whenever
 * any of the source topics emits an event.
 *
 * Cluster note: live.effect fires on every replica that received the
 * source publish (the bus subscriber's local fan-out re-triggers the
 * framework's effect wrap). For a pure side-effect handler (one that
 * has external consequences like writing to a durable store, sending
 * a notification, calling a webhook), this means N replicas = N
 * duplicate side effects per source event. The fix is to leader-gate
 * the handler so it runs exactly once cluster-wide. Aggregates and
 * derived streams do not need this gate - they read shared state and
 * produce idempotent output.
 *
 * Storage is cluster-shared via Redis LISTs. Each adjacent stream caps
 * at FEED_CAP entries, FIFO-evicted on LTRIM.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { redis, leader } from '$lib/server/redis'

const FEED_CAP = 30

const PRODUCT_PRICES = {
	bagel: 4,
	coffee: 5,
	cookie: 3,
	muffin: 6
}

const ORDERS_KEY = 'demos:effect:orders'
const AUDIT_KEY = 'demos:effect:audit'
const NOTIF_KEY = 'demos:effect:notifications'

/**
 * Append entry to a capped LIST (newest first). Captures any entries
 * the LTRIM is about to drop so the caller can publish 'deleted' per
 * evicted id, then publishes 'created' for the new entry.
 */
async function appendCapped(key, topic, entry, ctx) {
	const raw = JSON.stringify(entry)
	const pipeline = redis.redis.multi()
	pipeline.lpush(key, raw)
	pipeline.lrange(key, FEED_CAP, -1)
	pipeline.ltrim(key, 0, FEED_CAP - 1)
	const results = await pipeline.exec()
	const evicted = /** @type {string[]} */ (results?.[1]?.[1] ?? [])
	for (const evictedRaw of evicted) {
		try {
			const dropped = JSON.parse(evictedRaw)
			ctx.publish(topic, 'deleted', { id: dropped.id })
		} catch { /* corrupt entry already evicted */ }
	}
	ctx.publish(topic, 'created', entry)
}

async function readList(key) {
	const raws = await redis.redis.lrange(key, 0, -1)
	const out = []
	for (const raw of raws) {
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
	}
	return out
}

export const myEffectState = live(async () => ({
	products: Object.entries(PRODUCT_PRICES).map(([name, price]) => ({ name, price })),
	feedCap: FEED_CAP
}))

export const placeOrder = live(async (ctx, args) => {
	const productName = typeof args?.productName === 'string' && PRODUCT_PRICES[args.productName] !== undefined
		? args.productName
		: null
	if (!productName) {
		throw new LiveError('VALIDATION', 'unknown product')
	}
	const qty = Math.max(1, Math.min(20, Math.floor(Number(args?.qty) || 1)))
	const order = {
		id: 'ord-' + crypto.randomUUID().slice(0, 8),
		productName,
		qty,
		total: PRODUCT_PRICES[productName] * qty,
		ts: Date.now(),
		buyerName: ctx.user?.name ?? '(unknown)',
		buyerColor: ctx.user?.color ?? '#888888'
	}
	await appendCapped(ORDERS_KEY, TOPICS.demoEffectOrders, order, ctx)
	return order
})

/**
 * Wipe all three feeds. Same fan-out as the clearFeeds RPC.
 */
export async function purge(ctx) {
	const [ordersRaws, auditRaws, notifRaws] = await Promise.all([
		redis.redis.lrange(ORDERS_KEY, 0, -1),
		redis.redis.lrange(AUDIT_KEY, 0, -1),
		redis.redis.lrange(NOTIF_KEY, 0, -1)
	])
	const counts = { orders: ordersRaws.length, audit: auditRaws.length, notifications: notifRaws.length }
	const pipeline = redis.redis.multi()
	pipeline.del(ORDERS_KEY)
	pipeline.del(AUDIT_KEY)
	pipeline.del(NOTIF_KEY)
	await pipeline.exec()

	function emit(raws, topic) {
		for (const raw of raws) {
			try {
				const e = JSON.parse(raw)
				ctx.publish(topic, 'deleted', { id: e.id })
			} catch { /* corrupt entry already gone */ }
		}
	}
	emit(ordersRaws, TOPICS.demoEffectOrders)
	emit(auditRaws, TOPICS.demoEffectAudit)
	emit(notifRaws, TOPICS.demoEffectNotifications)
	return counts
}

export const clearFeeds = live(async (ctx) => {
	await purge(ctx)
	return { ok: true }
})

/**
 * The headline. Fires on every publish to the orders topic. Reads
 * the event kind + data + platform; fans out to the audit and
 * notifications topics. Production handlers would also call email
 * services, write to durable stores, push to webhooks - the same
 * shape composes for any side-effect orchestration.
 *
 * Leader-gated cluster-wide: the live.effect wrap fires on every
 * replica that receives the source publish (the bus subscriber's
 * local fan-out re-triggers it), so without this gate one order
 * placement would generate one audit entry + one notification PER
 * replica - duplicate side effects. The gate runs the handler on
 * exactly one worker; the audit + notification publishes from that
 * worker reach every replica's subscribers via the cluster bus.
 *
 * Fire-and-forget: throws here are swallowed by the framework so a
 * downstream service outage doesn't fail the original publisher's
 * RPC. Log them via `live.onError(...)` if you want visibility.
 */
export const orderEffects = live.effect(
	[TOPICS.demoEffectOrders],
	async (event, data, platform) => {
		if (!leader.isLeader()) return
		// We only react to 'created' events. 'deleted' events from FIFO
		// eviction are not order placements; ignoring them keeps the
		// audit / notifications feeds focused on real user actions.
		if (event !== 'created') return
		if (!data || typeof data !== 'object') return

		const order = data
		const auditEntry = {
			id: 'aud-' + crypto.randomUUID().slice(0, 8),
			orderId: order.id,
			level: 'info',
			message: `order ${order.id}: ${order.qty}x ${order.productName} for $${order.total} placed by ${order.buyerName}`,
			ts: Date.now()
		}
		const notification = {
			id: 'ntf-' + crypto.randomUUID().slice(0, 8),
			orderId: order.id,
			message: `Thanks ${order.buyerName}! Your ${order.qty}x ${order.productName} is confirmed.`,
			ts: Date.now()
		}

		// platform here is the framework's wrapped platform; appendCapped
		// uses ctx.publish via the platform's publish path. From svelte-
		// realtime 0.5.6 the bus configured via configureCron({ bus }) in
		// hooks.ws.js is the single declaration of cluster intent, and the
		// framework auto-wraps the reactive seam's publish through it, so
		// the audit / notification frames here relay to every replica
		// without any per-handler bus.wrap call.
		const ctx = { publish: (t, ev, d) => platform.publish(t, ev, d) }
		await appendCapped(AUDIT_KEY, TOPICS.demoEffectAudit, auditEntry, ctx)
		await appendCapped(NOTIF_KEY, TOPICS.demoEffectNotifications, notification, ctx)
	}
)

export const ordersStream = live.stream(
	TOPICS.demoEffectOrders,
	async () => readList(ORDERS_KEY),
	{ merge: 'crud', key: 'id' }
)

export const auditStream = live.stream(
	TOPICS.demoEffectAudit,
	async () => readList(AUDIT_KEY),
	{ merge: 'crud', key: 'id' }
)

export const notificationsStream = live.stream(
	TOPICS.demoEffectNotifications,
	async () => readList(NOTIF_KEY),
	{ merge: 'crud', key: 'id' }
)
