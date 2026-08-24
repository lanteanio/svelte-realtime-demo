// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/auctions: deadline-bounded parallel `live.push` collection.
 *
 * The pitch. Any user lists a lot (item, starting price, reserve,
 * duration). The server fans out one `live.push({ userId },
 * 'demos:auction:bid-request', lot, { timeoutMs })` per bidder. Each
 * bidder's tab pops a card with the lot info plus a live current top
 * bid (driven by the active-lots stream). They enter an amount and
 * click Bid (or Pass, or just let it time out). The push reply
 * resolves with `{ amount, bidderName, bidderColor }` or
 * `{ pass: true }`. The server uses `Promise.allSettled` to wait for
 * every reply (or its timeout) by the deadline, then awards the lot
 * to the highest valid bid above the reserve.
 *
 * The headline primitive: live.push x N parallel + Promise.allSettled.
 * Spectator drama: each accepted bid triggers an immediate
 * `ctx.publish('updated', ...)` on the active-lots stream AND an HSET
 * on the cluster-shared lot record, so a spectator joining mid-auction
 * on any replica sees the bids-so-far via the loader (not just live
 * events arriving after their subscribe).
 *
 * Storage is cluster-shared via Redis (HASH for active lots, LIST for
 * recent results). The per-seller active-lot cap also reads from the
 * HASH, so a seller cannot bypass it by hopping between replicas.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { redis } from '$lib/server/redis'

const PUSH_EVENT = 'demos:auction:bid-request'

const MAX_ITEM_LEN = 60
const MAX_PRICE = 1_000_000
const MIN_DURATION_SEC = 3
const MAX_DURATION_SEC = 30
const MAX_RECIPIENTS = 50
const MAX_ACTIVE_PER_SELLER = 3
const RECENT_CAP = 30
const PUSH_GRACE_MS = 1500

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

const ACTIVE_KEY = 'demos:auctions:active'
const RECENT_KEY = 'demos:auctions:recent'

function publicLot(lot) {
	return {
		id: lot.id,
		item: lot.item,
		sellerId: lot.sellerId,
		sellerName: lot.sellerName,
		sellerColor: lot.sellerColor,
		startingPrice: lot.startingPrice,
		reservePrice: lot.reservePrice,
		durationSec: lot.durationSec,
		startedAt: lot.startedAt,
		deadlineAt: lot.deadlineAt,
		recipientCount: lot.recipientCount,
		bids: lot.bids.slice()
	}
}

async function listActive() {
	const raws = await redis.redis.hvals(ACTIVE_KEY)
	const out = []
	for (const raw of raws) {
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
	}
	return out
}

async function listRecent() {
	const raws = await redis.redis.lrange(RECENT_KEY, 0, -1)
	const out = []
	for (const raw of raws) {
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
	}
	return out
}

async function countActiveBySeller(sellerId) {
	const all = await listActive()
	let n = 0
	for (const lot of all) {
		if (lot.sellerId === sellerId) n++
	}
	return n
}

async function archive(lot, status, winner, soldPrice, ctx) {
	const record = {
		...publicLot(lot),
		closedAt: Date.now(),
		status,
		winnerId: winner?.id ?? null,
		winnerName: winner?.name ?? null,
		winnerColor: winner?.color ?? null,
		soldPrice
	}
	const raw = JSON.stringify(record)
	// LPUSH puts newest first; LTRIM bounds the list at RECENT_CAP.
	// LRANGE(RECENT_CAP, -1) captures any entries the subsequent LTRIM
	// will drop so subscribers see a 'deleted' event per evicted record.
	const pipeline = redis.redis.multi()
	pipeline.lpush(RECENT_KEY, raw)
	pipeline.lrange(RECENT_KEY, RECENT_CAP, -1)
	pipeline.ltrim(RECENT_KEY, 0, RECENT_CAP - 1)
	const results = await pipeline.exec()
	const evicted = /** @type {string[]} */ (results?.[1]?.[1] ?? [])
	for (const evictedRaw of evicted) {
		try {
			const dropped = JSON.parse(evictedRaw)
			ctx.publish(TOPICS.demoAuctionsRecent, 'deleted', { id: dropped.id })
		} catch { /* corrupt entry already gone */ }
	}
	ctx.publish(TOPICS.demoAuctionsRecent, 'created', record)
}

function sanitizeName(s) {
	return typeof s === 'string' && s.length > 0 ? s.slice(0, 40) : '(unknown)'
}

function sanitizeColor(s) {
	return typeof s === 'string' && HEX_COLOR_RE.test(s) ? s : '#888888'
}

/**
 * Page-load probe. Mirrors the my{Foo}State convention so the page
 * renders caps and the push event name without hard-coding them.
 */
export const myAuctionsState = live(async () => ({
	maxItemLen: MAX_ITEM_LEN,
	maxPrice: MAX_PRICE,
	minDurationSec: MIN_DURATION_SEC,
	maxDurationSec: MAX_DURATION_SEC,
	maxRecipients: MAX_RECIPIENTS,
	maxActivePerSeller: MAX_ACTIVE_PER_SELLER,
	pushEvent: PUSH_EVENT
}))

/**
 * Collect bids for one lot and settle it. Runs DETACHED from the RPC
 * that listed the lot: fans out one `live.push` per recipient, each
 * accepted bid is appended to lot.bids, HSET back to the cluster-shared
 * lot record, and a fresh 'updated' event is published immediately,
 * driving the live race. After Promise.allSettled (every reply has
 * resolved, passed, or timed out) and the listed duration has elapsed,
 * the highest bid above reserve wins; otherwise no-sale. The lot is
 * removed from active and archived to the recent stream, which is how
 * every participant - the seller included - learns the outcome.
 *
 * `ctx.publish` is platform-scoped, not request-scoped, so publishing
 * after the listing RPC has returned is the same operation the crons
 * perform; nothing here depends on the RPC still being open.
 */
async function runAuction(ctx, lot, recipientIds) {
	const { id, startingPrice, reservePrice, deadlineAt } = lot
	const timeoutMs = lot.durationSec * 1000 + PUSH_GRACE_MS
	const payload = publicLot(lot)

	await Promise.allSettled(recipientIds.map(async (toUserId) => {
		try {
			const reply = await live.push({ userId: toUserId }, PUSH_EVENT, payload, { timeoutMs })
			if (!reply || reply.pass === true) return
			const amount = Math.floor(Number(reply.amount))
			if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_PRICE) return
			if (amount < startingPrice) return
			lot.bids.push({
				bidderId: toUserId,
				bidderName: sanitizeName(reply.bidderName),
				bidderColor: sanitizeColor(reply.bidderColor),
				amount,
				ts: Date.now()
			})
			// Persist the new bid into the cluster-shared lot record so a
			// spectator joining mid-auction on any replica sees the bid via
			// the loader, not only via subsequently-arriving live events.
			await redis.redis.hset(ACTIVE_KEY, id, JSON.stringify(publicLot(lot)))
			ctx.publish(TOPICS.demoAuctionsActive, 'updated', publicLot(lot))
		} catch {
			// NOT_FOUND, timeout, handler-error: silent. Treated as pass.
		}
	}))

	// Honor the listed duration as a minimum even when all replies land
	// early. Without this, a single-bidder reply collapses the lot in
	// milliseconds and reads visually as "click Bid = item sold." The
	// per-bid `ctx.publish` already fired inside the map, so spectators
	// keep watching the live waterfall + countdown while we wait here.
	const remaining = deadlineAt - Date.now()
	if (remaining > 0) {
		await new Promise((resolve) => setTimeout(resolve, remaining))
	}

	await redis.redis.hdel(ACTIVE_KEY, id)
	ctx.publish(TOPICS.demoAuctionsActive, 'deleted', { id })

	if (lot.bids.length === 0) {
		await archive(lot, 'no-sale', null, null, ctx)
		return
	}

	const sorted = lot.bids.slice().sort((a, b) => b.amount - a.amount || a.ts - b.ts)
	const top = sorted[0]
	if (top.amount < reservePrice) {
		await archive(lot, 'no-sale', null, null, ctx)
		return
	}

	const winner = { id: top.bidderId, name: top.bidderName, color: top.bidderColor }
	await archive(lot, 'sold', winner, top.amount, ctx)
}

/**
 * The headline RPC. Object-arg form:
 *
 *   createAuction({
 *     item: 'Vintage typewriter',
 *     startingPrice: 10,
 *     reservePrice: 25,
 *     durationSec: 8,
 *     recipientIds: ['uuid-of-bidder-a', 'uuid-of-bidder-b']
 *   })
 *
 * Validates inputs, publishes the lot to the active-lots stream so
 * spectators see it appear, starts the bidding run in the background,
 * and returns `{ status: 'listed' }` IMMEDIATELY. It does not wait for
 * the auction: at the slider's maximum the collection needs
 * durationSec*1000 + PUSH_GRACE_MS to settle, which is longer than the
 * caller's own RPC timeout - an await here made the top of the slider
 * deterministically unusable, and every other value a spinner for its
 * whole duration. The outcome arrives where every other participant
 * already reads it: the lot leaves the active stream and lands on the
 * recent stream with its final status.
 *
 * The one case still answered synchronously is `no-bidders`: there is
 * no run to wait for, and the immediate final answer is what the empty
 * room deserves.
 */
export const createAuction = live(async (ctx, args) => {
	const sellerId = ctx.user?.id
	if (typeof sellerId !== 'string' || !UUID_RE.test(sellerId)) {
		throw new LiveError('VALIDATION', 'no identity')
	}
	const sellerName = sanitizeName(ctx.user?.name)
	const sellerColor = sanitizeColor(ctx.user?.color)

	const item = typeof args?.item === 'string' ? args.item.trim().slice(0, MAX_ITEM_LEN) : ''
	if (item.length === 0) throw new LiveError('VALIDATION', 'item required')

	const startingPrice = Math.floor(Number(args?.startingPrice))
	if (!Number.isFinite(startingPrice) || startingPrice < 0 || startingPrice > MAX_PRICE) {
		throw new LiveError('VALIDATION', 'startingPrice out of range')
	}

	const reservePrice = Math.floor(Number(args?.reservePrice))
	if (!Number.isFinite(reservePrice) || reservePrice < startingPrice || reservePrice > MAX_PRICE) {
		throw new LiveError('VALIDATION', 'reservePrice must be between startingPrice and the cap')
	}

	const durationSec = Math.floor(Number(args?.durationSec))
	if (!Number.isFinite(durationSec) || durationSec < MIN_DURATION_SEC || durationSec > MAX_DURATION_SEC) {
		throw new LiveError('VALIDATION', `durationSec must be ${MIN_DURATION_SEC}..${MAX_DURATION_SEC}`)
	}

	const rawIds = Array.isArray(args?.recipientIds) ? args.recipientIds : []
	const recipientIds = []
	const seen = new Set()
	for (const rid of rawIds) {
		if (typeof rid !== 'string' || !UUID_RE.test(rid)) continue
		if (rid === sellerId) continue
		if (seen.has(rid)) continue
		seen.add(rid)
		recipientIds.push(rid)
		if (recipientIds.length >= MAX_RECIPIENTS) break
	}

	const activeCount = await countActiveBySeller(sellerId)
	if (activeCount >= MAX_ACTIVE_PER_SELLER) {
		throw new LiveError('VALIDATION', `max ${MAX_ACTIVE_PER_SELLER} active lots per seller`)
	}

	const id = crypto.randomUUID()
	const startedAt = Date.now()
	const deadlineAt = startedAt + durationSec * 1000
	const lot = {
		id,
		item,
		sellerId,
		sellerName,
		sellerColor,
		startingPrice,
		reservePrice,
		durationSec,
		startedAt,
		deadlineAt,
		recipientCount: recipientIds.length,
		bids: []
	}

	await redis.redis.hset(ACTIVE_KEY, id, JSON.stringify(publicLot(lot)))
	ctx.publish(TOPICS.demoAuctionsActive, 'created', publicLot(lot))

	if (recipientIds.length === 0) {
		await redis.redis.hdel(ACTIVE_KEY, id)
		ctx.publish(TOPICS.demoAuctionsActive, 'deleted', { id })
		await archive(lot, 'no-bidders', null, null, ctx)
		return { ok: true, status: 'no-bidders', id, soldPrice: null, winnerId: null, winnerName: null }
	}

	// Detached on purpose - see runAuction's doc for why the RPC must not
	// wait. The catch is the backstop for the awaits the run makes between
	// bids (Redis writes, the archive): the run must not die leaving the
	// lot live forever, so cleanup is attempted and the failure is logged
	// rather than swallowed. No recent record is fabricated for a run that
	// crashed - the lot simply leaves the active stream.
	runAuction(ctx, lot, recipientIds).catch(async (err) => {
		console.error(`[auctions] bidding run for lot ${id} failed:`, err)
		try {
			await redis.redis.hdel(ACTIVE_KEY, id)
			ctx.publish(TOPICS.demoAuctionsActive, 'deleted', { id })
		} catch { /* redis is down; the record is unreachable either way */ }
	})

	return { ok: true, status: 'listed', id, deadlineAt, recipientCount: recipientIds.length }
})

/**
 * Wipe the recent-results list. Active lots are intentionally NOT
 * purged: each has a bidding run awaiting Promise.allSettled over its
 * per-bidder live.push calls, and yanking the lot out from under those
 * awaiters would have the run settle a lot the world no longer shows.
 * Active lots already self-evict at their deadline (durationSec, max
 * MAX_DURATION_SEC = 30s), so the worst case is a 30s wait before
 * Redis drains itself.
 */
export async function purge(ctx) {
	const raws = await redis.redis.lrange(RECENT_KEY, 0, -1)
	await redis.redis.del(RECENT_KEY)
	for (const raw of raws) {
		try {
			const lot = JSON.parse(raw)
			ctx.publish(TOPICS.demoAuctionsRecent, 'deleted', { id: lot.id })
		} catch { /* corrupt entry already gone */ }
	}
	const activeCount = await redis.redis.hlen(ACTIVE_KEY)
	return { recent: raws.length, activeKept: activeCount }
}

/** Live stream of in-flight lots. */
export const activeAuctions = live.stream(
	TOPICS.demoAuctionsActive,
	async () => listActive(),
	{ merge: 'crud', key: 'id' }
)

/** Live stream of completed lots. Newest first; capped at RECENT_CAP. */
export const recentResults = live.stream(
	TOPICS.demoAuctionsRecent,
	async () => listRecent(),
	{ merge: 'crud', key: 'id' }
)
