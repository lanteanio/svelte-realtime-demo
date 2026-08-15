// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/flash-sales: atomic inventory decrement under contention,
 * one-coupon-per-user, plus a stress path that surfaces LOCK_TIMEOUT.
 *
 * The pitch. Three products with limited stock. Multiple users click
 * Buy. The server uses `live.lock({ key, maxWaitMs })` to single-flight
 * the decrement per item; concurrent buys on the same product run
 * serially in FIFO order; concurrent buys on different products run in
 * parallel. When the queue depth on one product piles up, queued
 * waiters reject with `LiveError('LOCK_TIMEOUT', ...)` after the bound
 * elapses, modelling the "queue too long, try again" UX of a real
 * flash sale. The lock is per-replica (framework default in-process),
 * which gives the serialization-with-delay behaviour the demo's
 * pitch needs. Inventory CORRECTNESS across replicas rides on atomic
 * Redis DECR independently of the lock: two replicas decrementing the
 * same product never overshoot zero. Sales feed and coupon state both
 * live in Redis so the cluster sees a single shared view.
 *
 * The one-coupon-per-user rule rides `live.idempotent` keyed on the
 * caller's userId for fast same-replica dedup, with a cluster-shared
 * SISMEMBER guard so a user hitting a different replica on a retry
 * does not get a second coupon from a Redis-cache miss on the new
 * replica's idempotency store.
 *
 * Three headline primitives in one page: `live.lock` for atomic
 * read-modify-write under contention (in-process per replica, which a
 * multi-instance deployment swaps for `createDistributedLock` without
 * changing the caller-facing API), `live.idempotent` for per-user
 * dedup, and atomic Redis `DECR` for the actual inventory rule (the
 * lock gives the demo its serialization behavior; the atomic DECR
 * gives the system its correctness).
 *
 * Storage is cluster-shared via Redis. Recent sales feed capped at
 * SALES_CAP, FIFO-evicted via LTRIM.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { createIdempotencyStore } from 'svelte-adapter-uws-extensions/redis/idempotency'
import { TOPICS } from '$lib/server/topics'
import { redis, breaker } from '$lib/server/redis'
import { metrics } from '$lib/server/metrics'

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

/**
 * Cluster-shared idempotency store for the coupon claim, in a key namespace
 * this demo owns outright.
 *
 * Two reasons it is not the framework's in-process default. It is per-replica,
 * so a retry landing elsewhere would cold-miss and re-run the claim. And it
 * cannot be emptied: `resetSale` restores the coupon pool and the holders set,
 * but a cache it does not own keeps replaying each visitor's first reply, so
 * the claim body never runs again and the pool never moves - a reset that
 * looks complete and is not.
 *
 * The exclusive `keyPrefix` is what makes the reset honest rather than
 * destructive: `clear()` empties the prefix, so nothing else may be filed
 * under it. The other demos that take a store follow the same rule with their
 * own prefixes.
 */
const idempotencyStore = createIdempotencyStore(redis, {
	keyPrefix: 'demos:flash:idemp:',
	ttl: 3600,
	acquireTtl: 30,
	breaker,
	metrics
})

const SALES_KEY = 'demos:flash:sales'
const HOLDERS_KEY = 'demos:flash:coupons:holders'
const POOL_KEY = 'demos:flash:coupons:pool'
const SEEDED_KEY = 'demos:flash:seeded'
const stockKey = (id) => `demos:flash:stock:${id}`
const soldKey = (id) => `demos:flash:sold:${id}`

/**
 * One-shot cluster-wide seed. SETNX wins on exactly one worker; the
 * winner SETs initial stock + sold for every product and the coupon
 * pool. Subsequent boots short-circuit. EX matches the demo's typical
 * idle window so a fully unused deploy lets Redis reclaim the marker;
 * the next boot re-seeds.
 */
async function seedIfNeeded() {
	try {
		const ok = await redis.redis.set(SEEDED_KEY, '1', 'NX', 'EX', 3600)
		if (ok !== 'OK') return
		const pipeline = redis.redis.multi()
		for (const p of PRODUCTS_INITIAL) {
			pipeline.set(stockKey(p.id), p.stockInitial)
			pipeline.set(soldKey(p.id), 0)
		}
		pipeline.set(POOL_KEY, COUPON_POOL_INITIAL)
		pipeline.del(SALES_KEY)
		pipeline.del(HOLDERS_KEY)
		await pipeline.exec()
	} catch {
		// Best-effort - a Redis blip during boot defers seeding to the
		// next worker. Reads against unset keys are treated as zero.
	}
}
seedIfNeeded()

async function readStockSold(id) {
	const [stockRaw, soldRaw] = await redis.redis.mget(stockKey(id), soldKey(id))
	const stock = stockRaw === null ? 0 : Number(stockRaw)
	const sold = soldRaw === null ? 0 : Number(soldRaw)
	return {
		stock: Number.isFinite(stock) ? stock : 0,
		sold: Number.isFinite(sold) ? sold : 0
	}
}

async function publicProduct(p) {
	const { stock, sold } = await readStockSold(p.id)
	return {
		id: p.id,
		name: p.name,
		originalPrice: p.originalPrice,
		salePrice: p.salePrice,
		stock,
		stockInitial: p.stockInitial,
		sold,
		soldOut: stock <= 0
	}
}

async function getPool() {
	const v = await redis.redis.get(POOL_KEY)
	if (v === null) return COUPON_POOL_INITIAL
	const n = Number(v)
	return Number.isFinite(n) ? n : COUPON_POOL_INITIAL
}

/** Page-load probe. Returns caps and the user's coupon-redemption state. */
export const myFlashState = live(async (ctx) => {
	const userId = ctx.user?.id ?? null
	const [pool, alreadyClaimed] = await Promise.all([
		getPool(),
		typeof userId === 'string'
			? redis.redis.sismember(HOLDERS_KEY, userId).then((n) => n === 1)
			: Promise.resolve(false)
	])
	return {
		productLockMaxWaitMs: PRODUCT_LOCK_MAX_WAIT_MS,
		perBuyDelayMs: PER_BUY_DELAY_MS,
		salesCap: SALES_CAP,
		couponCode: COUPON_CODE,
		couponPoolInitial: COUPON_POOL_INITIAL,
		couponPoolRemaining: pool,
		alreadyClaimed
	}
})

/**
 * The headline RPC. `live.lock({ key, maxWaitMs })` wraps the body in
 * a per-replica per-product mutex (in-process lock - the framework's
 * default). Inventory correctness for the cluster comes from atomic
 * Redis DECR; the lock here exists to give the demo its serialization
 * behaviour. Per-replica queue depth means a 2-replica deploy can
 * accumulate ~2x the queued waiters before LOCK_TIMEOUT trips, which
 * is acceptable for a demo - the pitch (queue-too-long rejects) still
 * surfaces, just on a per-replica scale.
 *
 * The `maxWaitMs: 1500` bound rejects queued waiters with
 * `LiveError('LOCK_TIMEOUT', ...)` once the queue exceeds ~18 deep.
 * Surfaces in the UI as a "queue too long, try again" toast.
 *
 * Inventory correctness rides on atomic Redis DECR: even if the lock
 * is somehow bypassed (debug shortcut, multi-replica), two concurrent
 * decrements cannot both succeed past zero. The compensating INCR on
 * negative result restores the count before throwing SOLD_OUT.
 */
export const buyProduct = live.lock(
	{
		key: (ctx, productId) => typeof productId === 'string' ? 'flash:product:' + productId : null,
		maxWaitMs: PRODUCT_LOCK_MAX_WAIT_MS
	},
	async (ctx, productId) => {
		const config = PRODUCTS_INITIAL.find((p) => p.id === productId)
		if (!config) {
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

		const newStock = await redis.redis.decr(stockKey(productId))
		if (newStock < 0) {
			await redis.redis.incr(stockKey(productId))
			throw new LiveError('SOLD_OUT', 'no stock remaining')
		}
		const newSold = await redis.redis.incr(soldKey(productId))

		const sale = {
			id: crypto.randomUUID(),
			productId: config.id,
			productName: config.name,
			salePrice: config.salePrice,
			buyerId: ctx.user?.id ?? null,
			buyerName: ctx.user?.name ?? '(unknown)',
			buyerColor: ctx.user?.color ?? '#888888',
			ts: Date.now()
		}
		// LPUSH puts newest first; LTRIM bounds the list at SALES_CAP.
		// LTRIM returns the kept range, so anything past index SALES_CAP-1
		// is dropped. We read the trimmed tail before LTRIM so we can
		// publish 'deleted' for each evicted entry.
		const pipeline = redis.redis.multi()
		pipeline.lpush(SALES_KEY, JSON.stringify(sale))
		pipeline.lrange(SALES_KEY, SALES_CAP, -1)
		pipeline.ltrim(SALES_KEY, 0, SALES_CAP - 1)
		const results = await pipeline.exec()
		const evicted = (results?.[1]?.[1] ?? []) /** @type {string[]} */
		for (const raw of evicted) {
			try {
				const dropped = JSON.parse(raw)
				ctx.publish(TOPICS.demoFlashSales, 'deleted', { id: dropped.id })
			} catch { /* corrupt entry already evicted */ }
		}

		const productPayload = {
			id: config.id,
			name: config.name,
			originalPrice: config.originalPrice,
			salePrice: config.salePrice,
			stock: newStock,
			stockInitial: config.stockInitial,
			sold: newSold,
			soldOut: newStock <= 0
		}
		ctx.publish(TOPICS.demoFlashSales, 'created', sale)
		ctx.publish(TOPICS.demoFlashProducts, 'updated', productPayload)

		return { ok: true, sale, product: productPayload }
	}
)

/**
 * One-coupon-per-user rule. `live.idempotent` gives fast same-replica
 * dedup; the cluster-correctness comes from the SISMEMBER guard +
 * compensating-INCR on the SADD-was-already-present race. A user
 * hitting a different replica on a retry cannot extract a second
 * coupon from the new replica's empty idempotency cache.
 */
export const claimCoupon = live.idempotent(
	{
		keyFrom: (ctx) => typeof ctx.user?.id === 'string' ? 'flash:coupon:' + ctx.user.id : null,
		ttl: 3600,
		store: idempotencyStore
	},
	async (ctx) => {
		const userId = ctx.user?.id
		if (typeof userId !== 'string') {
			throw new LiveError('VALIDATION', 'no identity')
		}
		// SADD is itself an atomic test-and-set, so making it the gate means
		// exactly one caller in the cluster can ever reach the decrement.
		// Reading membership first and adding last let both replicas pass the
		// read and decrement twice, leaving the pool transiently short and
		// relying on the loser's compensating INCR to restore it - so a worker
		// that dies between its decrement and that INCR retires a coupon that
		// nobody holds. Gating on the add removes the window instead of
		// compensating for it.
		const added = await redis.redis.sadd(HOLDERS_KEY, userId)
		if (added === 0) {
			return { ok: true, code: COUPON_CODE, poolRemaining: await getPool() }
		}
		const newPool = await redis.redis.decr(POOL_KEY)
		if (newPool < 0) {
			await redis.redis.incr(POOL_KEY)
			// Release the gate. The claim did not happen, so this user must not
			// be recorded as a holder, or a later refill could never reach them.
			await redis.redis.srem(HOLDERS_KEY, userId)
			throw new LiveError('SOLD_OUT', 'coupon pool exhausted')
		}
		// The reply reaches only the caller, so without this the OTHER tab keeps
		// whatever it last believed. That tab is not merely stale, it is stale in
		// both directions: before this publish existed it read its own duplicate
		// claim's GET, which races this decrement and returns the pre-claim
		// number. Publishing lets the replica that actually performed the
		// decrement be the one that reports it.
		ctx.publish(TOPICS.demoFlashCoupons, 'set', { poolRemaining: newPool })
		return { ok: true, code: COUPON_CODE, poolRemaining: newPool }
	}
)

/**
 * Test-only escape hatch. Replenishes stock and clears the coupon
 * pool so the e2e suite starts each test from a known baseline. Resets
 * are cluster-wide via straight SET / DEL (no SETNX) so they overwrite
 * whatever state the prior test left behind.
 *
 * That includes the cached claim replies. Restoring the pool and emptying the
 * holders set is not enough on its own: a visitor who already claimed would
 * have their first reply replayed, so the claim body would not run, no SADD
 * and no DECR would happen, and the pool would sit at its reset value while
 * the page reported a fresh claim. The cache is cleared LAST, after the
 * pipeline: a claim arriving in between lands on the already-restored holders
 * set and pool, and only its now-redundant cache entry is dropped.
 */
export const resetSale = live(async (ctx) => {
	// Capture sales before delete so we can publish 'deleted' per id. A
	// buyProduct landing between the LRANGE and the DEL is harmless: its
	// sale is removed by the DEL anyway; we just miss the 'deleted'
	// event for that one entry, which the next subscribe re-syncs.
	const salesRaws = await redis.redis.lrange(SALES_KEY, 0, -1)

	const pipeline = redis.redis.multi()
	for (const p of PRODUCTS_INITIAL) {
		pipeline.set(stockKey(p.id), p.stockInitial)
		pipeline.set(soldKey(p.id), 0)
	}
	pipeline.set(POOL_KEY, COUPON_POOL_INITIAL)
	pipeline.del(HOLDERS_KEY)
	pipeline.del(SALES_KEY)
	await pipeline.exec()
	await idempotencyStore.clear()

	for (const raw of salesRaws) {
		try {
			const s = JSON.parse(raw)
			ctx.publish(TOPICS.demoFlashSales, 'deleted', { id: s.id })
		} catch { /* corrupt entry already gone */ }
	}
	ctx.publish(TOPICS.demoFlashCoupons, 'set', { poolRemaining: COUPON_POOL_INITIAL })
	for (const p of PRODUCTS_INITIAL) {
		ctx.publish(TOPICS.demoFlashProducts, 'updated', {
			id: p.id,
			name: p.name,
			originalPrice: p.originalPrice,
			salePrice: p.salePrice,
			stock: p.stockInitial,
			stockInitial: p.stockInitial,
			sold: 0,
			soldOut: p.stockInitial <= 0
		})
	}
	return { ok: true }
})

/**
 * The coupon pool as a live value rather than an RPC reply.
 *
 * A claim on another replica moves this number, and a tab that did not make
 * that claim has no other way to learn it moved: the reply only reaches the
 * caller. Publishing it is also what makes the answer self-correcting, since
 * the authoritative number arrives from whichever replica actually performed
 * the decrement rather than from each tab's own view of the race.
 */
export const couponPool = live.stream(
	TOPICS.demoFlashCoupons,
	async () => ({ poolRemaining: await getPool() }),
	{ merge: 'set' }
)

/** Live stream of product cards (stock + sold updates per buy). */
export const productList = live.stream(
	TOPICS.demoFlashProducts,
	async () => Promise.all(PRODUCTS_INITIAL.map(publicProduct)),
	{ merge: 'crud', key: 'id' }
)

/** Live stream of recent sales. Newest first; FIFO-evicted on overflow. */
export const recentSales = live.stream(
	TOPICS.demoFlashSales,
	async () => {
		const raws = await redis.redis.lrange(SALES_KEY, 0, -1)
		const out = []
		for (const raw of raws) {
			try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
		}
		return out
	},
	{ merge: 'crud', key: 'id' }
)
