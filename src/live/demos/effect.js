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
 * The effect's handler can `platform.publish(...)` to fan out, call
 * external services (email, SMS, webhooks), write to durable
 * stores, or any combination. In production this is the canonical
 * shape for orchestration: "when X happens, do Y, Z, W in parallel
 * without coupling them to the X publisher."
 *
 * Storage is in-memory. Each adjacent stream caps at FEED_CAP
 * entries, FIFO-evicted.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

const FEED_CAP = 30

const PRODUCT_PRICES = {
	bagel: 4,
	coffee: 5,
	cookie: 3,
	muffin: 6
}

/** @type {Array<{ id: string, productName: string, qty: number, total: number, ts: number, buyerName: string, buyerColor: string }>} */
const orders = []

/** @type {Array<{ id: string, orderId: string, level: string, message: string, ts: number }>} */
const auditEntries = []

/** @type {Array<{ id: string, orderId: string, message: string, ts: number }>} */
const notifications = []

function shiftIfFull(arr, cap) {
	while (arr.length > cap) arr.pop()
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
	orders.unshift(order)
	while (orders.length > FEED_CAP) {
		const dropped = orders.pop()
		ctx.publish(TOPICS.demoEffectOrders, 'deleted', { id: dropped.id })
	}
	ctx.publish(TOPICS.demoEffectOrders, 'created', order)
	return order
})

/**
 * Wipe all three feeds. Same fan-out as the existing clearFeeds RPC.
 */
export async function purge(ctx) {
	const counts = { orders: orders.length, audit: auditEntries.length, notifications: notifications.length }
	for (const o of orders) ctx.publish(TOPICS.demoEffectOrders, 'deleted', { id: o.id })
	for (const a of auditEntries) ctx.publish(TOPICS.demoEffectAudit, 'deleted', { id: a.id })
	for (const n of notifications) ctx.publish(TOPICS.demoEffectNotifications, 'deleted', { id: n.id })
	orders.length = 0
	auditEntries.length = 0
	notifications.length = 0
	return counts
}

export const clearFeeds = live(async (ctx) => {
	for (const o of orders.slice()) ctx.publish(TOPICS.demoEffectOrders, 'deleted', { id: o.id })
	for (const a of auditEntries.slice()) ctx.publish(TOPICS.demoEffectAudit, 'deleted', { id: a.id })
	for (const n of notifications.slice()) ctx.publish(TOPICS.demoEffectNotifications, 'deleted', { id: n.id })
	orders.length = 0
	auditEntries.length = 0
	notifications.length = 0
	return { ok: true }
})

/**
 * The headline. Fires on every publish to the orders topic. Reads
 * the event kind + data + platform; fans out to the audit and
 * notifications topics. Production handlers would also call email
 * services, write to durable stores, push to webhooks - the same
 * shape composes for any side-effect orchestration.
 *
 * Fire-and-forget: throws here are swallowed by the framework so a
 * downstream service outage doesn't fail the original publisher's
 * RPC. Log them via `live.onError(...)` if you want visibility.
 */
export const orderEffects = live.effect(
	[TOPICS.demoEffectOrders],
	async (event, data, platform) => {
		// We only react to 'created' events. 'deleted' events from FIFO
		// eviction are not order placements; ignoring them keeps the
		// audit / notifications feeds focused on real user actions.
		if (event !== 'created') return
		if (!data || typeof data !== 'object') return

		const order = data
		const auditId = 'aud-' + crypto.randomUUID().slice(0, 8)
		const notifId = 'ntf-' + crypto.randomUUID().slice(0, 8)

		const auditEntry = {
			id: auditId,
			orderId: order.id,
			level: 'info',
			message: `order ${order.id}: ${order.qty}x ${order.productName} for $${order.total} placed by ${order.buyerName}`,
			ts: Date.now()
		}
		const notification = {
			id: notifId,
			orderId: order.id,
			message: `Thanks ${order.buyerName}! Your ${order.qty}x ${order.productName} is confirmed.`,
			ts: Date.now()
		}

		auditEntries.unshift(auditEntry)
		shiftIfFull(auditEntries, FEED_CAP)
		notifications.unshift(notification)
		shiftIfFull(notifications, FEED_CAP)

		platform.publish(TOPICS.demoEffectAudit, 'created', auditEntry)
		platform.publish(TOPICS.demoEffectNotifications, 'created', notification)
	}
)

export const ordersStream = live.stream(
	TOPICS.demoEffectOrders,
	async () => orders.slice(),
	{ merge: 'crud', key: 'id' }
)

export const auditStream = live.stream(
	TOPICS.demoEffectAudit,
	async () => auditEntries.slice(),
	{ merge: 'crud', key: 'id' }
)

export const notificationsStream = live.stream(
	TOPICS.demoEffectNotifications,
	async () => notifications.slice(),
	{ merge: 'crud', key: 'id' }
)
