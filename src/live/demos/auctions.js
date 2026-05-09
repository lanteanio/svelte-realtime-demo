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
 * `ctx.publish('updated', ...)` on the active-lots stream, so the
 * waterfall of bids appears in real time on every tab subscribed to
 * the stream (the seller, fellow bidders, and idle spectators).
 *
 * Storage is in-memory. Recent results capped at RECENT_CAP, FIFO.
 * Per-seller active cap is MAX_ACTIVE_PER_SELLER.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

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

/** @type {Map<string, object>} active lots, keyed by lot id. */
const activeLots = new Map()

/** @type {Array<object>} completed lots, newest first, capped at RECENT_CAP. */
const recentAuctions = []

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

function archive(lot, status, winner, soldPrice, ctx) {
	const record = {
		...publicLot(lot),
		closedAt: Date.now(),
		status,
		winnerId: winner?.id ?? null,
		winnerName: winner?.name ?? null,
		winnerColor: winner?.color ?? null,
		soldPrice
	}
	recentAuctions.unshift(record)
	while (recentAuctions.length > RECENT_CAP) {
		const dropped = recentAuctions.pop()
		ctx.publish(TOPICS.demoAuctionsRecent, 'deleted', { id: dropped.id })
	}
	ctx.publish(TOPICS.demoAuctionsRecent, 'created', record)
}

function countActiveBySeller(sellerId) {
	let n = 0
	for (const lot of activeLots.values()) {
		if (lot.sellerId === sellerId) n++
	}
	return n
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
 * spectators see it appear, then fans out one `live.push` per
 * recipient (excluding self, deduped, capped). Each push that returns
 * a valid bid is appended to lot.bids and a fresh 'updated' event is
 * published immediately, driving the live race. After Promise.allSettled
 * (every reply has resolved, passed, or timed out), the highest bid
 * above reserve wins; otherwise no-sale. The lot is removed from active
 * and archived to the recent stream.
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

	if (countActiveBySeller(sellerId) >= MAX_ACTIVE_PER_SELLER) {
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

	activeLots.set(id, lot)
	ctx.publish(TOPICS.demoAuctionsActive, 'created', publicLot(lot))

	if (recipientIds.length === 0) {
		activeLots.delete(id)
		ctx.publish(TOPICS.demoAuctionsActive, 'deleted', { id })
		archive(lot, 'no-bidders', null, null, ctx)
		return { ok: true, status: 'no-bidders', id, soldPrice: null, winnerId: null, winnerName: null }
	}

	const timeoutMs = durationSec * 1000 + PUSH_GRACE_MS
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
			ctx.publish(TOPICS.demoAuctionsActive, 'updated', publicLot(lot))
		} catch {
			// NOT_FOUND, timeout, handler-error: silent. Treated as pass.
		}
	}))

	activeLots.delete(id)
	ctx.publish(TOPICS.demoAuctionsActive, 'deleted', { id })

	if (lot.bids.length === 0) {
		archive(lot, 'no-sale', null, null, ctx)
		return { ok: true, status: 'no-sale', id, soldPrice: null, winnerId: null, winnerName: null }
	}

	const sorted = lot.bids.slice().sort((a, b) => b.amount - a.amount || a.ts - b.ts)
	const top = sorted[0]
	if (top.amount < reservePrice) {
		archive(lot, 'no-sale', null, null, ctx)
		return { ok: true, status: 'no-sale', id, soldPrice: null, winnerId: null, winnerName: null }
	}

	const winner = { id: top.bidderId, name: top.bidderName, color: top.bidderColor }
	archive(lot, 'sold', winner, top.amount, ctx)
	return {
		ok: true,
		status: 'sold',
		id,
		soldPrice: top.amount,
		winnerId: winner.id,
		winnerName: winner.name
	}
})

/** Live stream of in-flight lots. */
export const activeAuctions = live.stream(
	TOPICS.demoAuctionsActive,
	async () => Array.from(activeLots.values()).map(publicLot),
	{ merge: 'crud', key: 'id' }
)

/** Live stream of completed lots. Newest first; capped at RECENT_CAP. */
export const recentResults = live.stream(
	TOPICS.demoAuctionsRecent,
	async () => recentAuctions.slice(),
	{ merge: 'crud', key: 'id' }
)
