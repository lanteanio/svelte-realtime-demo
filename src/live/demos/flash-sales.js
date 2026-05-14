/**
 * /demos/flash-sales: atomic inventory decrement under contention,
 * one-coupon-per-user, plus a stress path that surfaces LOCK_TIMEOUT.
 *
 * The pitch. Three products with limited stock. Multiple users click
 * Buy. The server uses `live.lock({ key: (ctx, id) => 'flash:product:'
 * + id, maxWaitMs: 1500 }, ...)` to single-flight the decrement per
 * item. Concurrent buys on the same product run serially in FIFO
 * order; concurrent buys on different products run in parallel. When
 * the queue depth on one product piles up, queued waiters reject with
 * `LiveError('LOCK_TIMEOUT', ...)` after the bound elapses, modelling
 * the "queue too long, try again" UX of a real flash sale.
 *
 * The one-coupon-per-user rule rides `live.idempotent` keyed on the
 * caller's userId: a second claim from the same user returns the
 * cached first response, never decrements the coupon pool a second
 * time, and surfaces as ALREADY_CLAIMED in the UI.
 *
 * Two headline primitives in one page: `live.lock` for atomic
 * read-modify-write under contention (NEW for the gallery), and
 * `live.idempotent` for per-user dedup (used in /demos/checkout for
 * per-call dedup; this exercises the per-user-key shape).
 *
 * Storage is in-memory. Recent sales feed capped at SALES_CAP, FIFO.
 * For multi-instance deployments the lock can be swapped to
 * `createDistributedLock(redis)` from
 * `svelte-adapter-uws-extensions/redis/lock` without changing this
 * caller-facing API.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

const PRODUCT_LOCK_MAX_WAIT_MS = 1500
const PER_BUY_DELAY_MS = 80
const SALES_CAP = 30
const COUPON_CODE = 'SAVE20'
const COUPON_POOL_INITIAL = 50

const PRODUCTS_INITIAL = [
	{ id: 'phone', name: 'Wireless earbuds', originalPrice: 99, salePrice: 29, stockInitial: 5 },
	{ id: 'watch', name: 'Smart watch', originalPrice: 299, salePrice: 119, stockInitial: 3 },
	{ id: 'speaker', name: 'Bluetooth speaker', originalPrice: 149, salePrice: 59, stockInitial: 8 }
]

/** @type {Map<string, { id: string, name: string, originalPrice: number, salePrice: number, stock: number, sold: number }>} */
const products = new Map()

/** @type {Array<{ id: string, productId: string, productName: string, salePrice: number, buyerId: string | null, buyerName: string, ts: number }>} */
const sales = []

/** @type {Set<string>} userIds that already redeemed the coupon. */
const couponHolders = new Set()
let couponPool = COUPON_POOL_INITIAL

resetState()

function resetState() {
	products.clear()
	for (const p of PRODUCTS_INITIAL) {
		products.set(p.id, {
			id: p.id,
			name: p.name,
			originalPrice: p.originalPrice,
			salePrice: p.salePrice,
			stock: p.stockInitial,
			sold: 0
		})
	}
	sales.length = 0
	couponHolders.clear()
	couponPool = COUPON_POOL_INITIAL
}

function publicProduct(p) {
	return {
		id: p.id,
		name: p.name,
		originalPrice: p.originalPrice,
		salePrice: p.salePrice,
		stock: p.stock,
		stockInitial: PRODUCTS_INITIAL.find((x) => x.id === p.id)?.stockInitial ?? p.stock,
		sold: p.sold,
		soldOut: p.stock <= 0
	}
}

/** Page-load probe. Returns caps and the user's coupon-redemption state. */
export const myFlashState = live(async (ctx) => {
	const userId = ctx.user?.id ?? null
	return {
		productLockMaxWaitMs: PRODUCT_LOCK_MAX_WAIT_MS,
		perBuyDelayMs: PER_BUY_DELAY_MS,
		salesCap: SALES_CAP,
		couponCode: COUPON_CODE,
		couponPoolInitial: COUPON_POOL_INITIAL,
		couponPoolRemaining: couponPool,
		alreadyClaimed: typeof userId === 'string' && couponHolders.has(userId)
	}
})

/**
 * The headline RPC. `live.lock({ key: ..., maxWaitMs: ... }, fn)`
 * wraps the body in a per-product mutex. Concurrent buys on the same
 * product serialize FIFO; concurrent buys on different products run
 * in parallel. The per-buy artificial delay (80ms) is a knob that
 * makes the contention observable - production would push the work
 * down to a Lua script for sub-millisecond runtimes.
 *
 * The `maxWaitMs: 1500` bound rejects queued waiters with
 * `LiveError('LOCK_TIMEOUT', ...)` once the queue exceeds ~18 deep.
 * Surfaces in the UI as a "queue too long, try again" toast. Models
 * the way a production flash sale rejects bursts past a soft cap
 * rather than letting users wait forever for a SOLD_OUT response.
 */
export const buyProduct = live.lock(
	{
		key: (ctx, productId) => typeof productId === 'string' ? 'flash:product:' + productId : null,
		maxWaitMs: PRODUCT_LOCK_MAX_WAIT_MS
	},
	async (ctx, productId) => {
		if (typeof productId !== 'string' || !products.has(productId)) {
			throw new LiveError('VALIDATION', 'unknown productId')
		}

		// Artificial work BEFORE the stock check so every call (success
		// or sold-out) holds the lock for the same duration. Without
		// this, sold-out callers short-circuit in microseconds and
		// queue depth never grows enough to surface LOCK_TIMEOUT. With
		// it, 20 stress calls at 80ms = 1.6s of lock-held time;
		// callers waiting past maxWaitMs (1500ms) reject with
		// LOCK_TIMEOUT, which is the pitch.
		await new Promise((resolve) => setTimeout(resolve, PER_BUY_DELAY_MS))

		const p = products.get(productId)
		if (p.stock <= 0) {
			throw new LiveError('SOLD_OUT', 'no stock remaining')
		}

		p.stock -= 1
		p.sold += 1

		const sale = {
			id: crypto.randomUUID(),
			productId: p.id,
			productName: p.name,
			salePrice: p.salePrice,
			buyerId: ctx.user?.id ?? null,
			buyerName: ctx.user?.name ?? '(unknown)',
			buyerColor: ctx.user?.color ?? '#888888',
			ts: Date.now()
		}
		sales.unshift(sale)
		while (sales.length > SALES_CAP) {
			const dropped = sales.pop()
			ctx.publish(TOPICS.demoFlashSales, 'deleted', { id: dropped.id })
		}
		ctx.publish(TOPICS.demoFlashSales, 'created', sale)
		ctx.publish(TOPICS.demoFlashProducts, 'updated', publicProduct(p))

		return { ok: true, sale, product: publicProduct(p) }
	}
)

/**
 * One-coupon-per-user rule via `live.idempotent` keyed on userId. A
 * second claim from the same user returns the cached first response;
 * the coupon pool decrements at most once per user.
 *
 * We don't gate on the user's id with a non-idempotent check because
 * a flaky reconnect-retry mid-claim would either let the user claim
 * twice (no idempotency) or surface a stale "ALREADY_CLAIMED" for
 * a request the user never saw succeed (over-strict). Idempotency
 * by userId is the production-shaped answer.
 */
export const claimCoupon = live.idempotent(
	{ keyFrom: (ctx) => typeof ctx.user?.id === 'string' ? 'flash:coupon:' + ctx.user.id : null, ttl: 3600 },
	async (ctx) => {
		const userId = ctx.user?.id
		if (typeof userId !== 'string') {
			throw new LiveError('VALIDATION', 'no identity')
		}
		if (couponPool <= 0) {
			throw new LiveError('SOLD_OUT', 'coupon pool exhausted')
		}
		couponHolders.add(userId)
		couponPool -= 1
		return {
			ok: true,
			code: COUPON_CODE,
			poolRemaining: couponPool
		}
	}
)

/**
 * Test-only escape hatch. Replenishes stock and clears the coupon
 * pool so the e2e suite starts each test from a known baseline.
 */
export const resetSale = live(async (ctx) => {
	resetState()
	for (const p of products.values()) {
		ctx.publish(TOPICS.demoFlashProducts, 'updated', publicProduct(p))
	}
	for (const s of sales.slice()) {
		ctx.publish(TOPICS.demoFlashSales, 'deleted', { id: s.id })
	}
	return { ok: true }
})

/** Live stream of product cards (stock + sold updates per buy). */
export const productList = live.stream(
	TOPICS.demoFlashProducts,
	async () => Array.from(products.values()).map(publicProduct),
	{ merge: 'crud', key: 'id' }
)

/** Live stream of recent sales. Newest first; FIFO-evicted on overflow. */
export const recentSales = live.stream(
	TOPICS.demoFlashSales,
	async () => sales.slice(),
	{ merge: 'crud', key: 'id' }
)
