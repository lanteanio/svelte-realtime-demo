/**
 * /demos/pagination: cursor-based load-more on a live stream.
 *
 * The pitch. A log feed with 200 entries, served in pages of 25. The
 * loader returns the paginated shape `{ data, hasMore, cursor }`;
 * the framework propagates `hasMore` to the client store and stamps
 * the cursor on the next subscribe envelope. The page calls
 * `logFeed.loadMore()` to advance, the framework merges the next
 * page into the existing list via `merge: 'crud'` keyed by id, the
 * UI reactively renders the longer list.
 *
 * Live updates compose: a new entry appended via `appendLogEntry`
 * publishes 'created' on the same topic, lands at the top of the
 * list regardless of which page boundaries the user has paged
 * through. The framework picks the right behaviour from
 * `merge: 'crud'` plus the per-event publish kind.
 *
 * One headline primitive: paginated subscribe via the loader
 * returning `{ data, hasMore, cursor }` plus the client store's
 * `loadMore()` method.
 *
 * Storage is cluster-shared via a Redis LIST (chronological order;
 * oldest at index 0) plus a counter for the next-id. A SETNX-guarded
 * seed inserts the initial 200 entries on the first worker boot so
 * multi-replica deploys do not multi-seed.
 */

import { live } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { redis } from '$lib/server/redis'

const TOTAL = 200
const PAGE_SIZE = 25

const SYNTHETIC_MESSAGES = [
	'GET /api/orders 200 12ms',
	'POST /api/checkout 201 87ms',
	'cache miss for product-catalog',
	'rate-limit applied to ip 10.0.0.42',
	'webhook dispatched: order.created',
	'cron tick: cleanup-stale-sessions',
	'redis circuit: closed -> half-open',
	'GET /healthz 200 1ms',
	'queue depth 142 (warn threshold 100)',
	'background job retry 2/3 for invoice-restamp',
	'feature-flag refresh: 18 entries',
	'GET /api/users/me 304 4ms'
]

const SEVERITIES = ['info', 'info', 'info', 'info', 'warn', 'error']

const ENTRIES_KEY = 'demos:pagination:entries'   // LIST: oldest first
const SEQ_KEY = 'demos:pagination:seq'           // counter: next entry seq
const SEEDED_KEY = 'demos:pagination:seeded'     // SETNX guard

async function seedIfNeeded() {
	try {
		const ok = await redis.redis.set(SEEDED_KEY, '1', 'NX', 'EX', 3600)
		if (ok !== 'OK') return
		const now = Date.now()
		const pipeline = redis.redis.multi()
		pipeline.del(ENTRIES_KEY)
		pipeline.set(SEQ_KEY, 0)
		for (let i = 0; i < TOTAL; i++) {
			const seq = i + 1
			// Oldest first: index 0 is the oldest entry, index TOTAL-1 is the
			// newest. The loader pages through this in chronological order, so
			// page 1 reads the oldest 25 and `loadMore` walks forward in time.
			// `appendLogEntry` pushes new entries onto the end and they land
			// at the bottom of the rendered list, which matches the
			// chronological-timeline pitch and avoids the prepend-vs-append
			// conflict between live `created` events and paginated catch-up.
			pipeline.rpush(ENTRIES_KEY, JSON.stringify({
				id: 'log-' + seq,
				ts: now - (TOTAL - i) * 10_000,
				severity: SEVERITIES[i % SEVERITIES.length],
				message: SYNTHETIC_MESSAGES[i % SYNTHETIC_MESSAGES.length],
				seq
			}))
		}
		pipeline.set(SEQ_KEY, TOTAL)
		await pipeline.exec()
	} catch {
		// Best-effort - a Redis blip during boot defers seeding to the
		// next worker.
	}
}
seedIfNeeded()

/**
 * Drop entries appended past the seeded TOTAL=200. The original seed
 * is left in place (it is not user content). The seq counter is
 * intentionally not reset so a subsequent appendLogEntry produces ids
 * beyond the highest one any current subscriber has cached.
 */
export async function purge(ctx) {
	const len = await redis.redis.llen(ENTRIES_KEY)
	if (len <= TOTAL) return { trimmed: 0 }
	const overflowRaws = await redis.redis.lrange(ENTRIES_KEY, TOTAL, -1)
	await redis.redis.ltrim(ENTRIES_KEY, 0, TOTAL - 1)
	for (const raw of overflowRaws) {
		try {
			const entry = JSON.parse(raw)
			ctx.publish(TOPICS.demoPaginationLog, 'deleted', { id: entry.id })
		} catch { /* corrupt entry already gone */ }
	}
	return { trimmed: overflowRaws.length }
}

export const myPaginationState = live(async () => ({
	totalAtBoot: TOTAL,
	pageSize: PAGE_SIZE,
	severities: ['info', 'warn', 'error']
}))

export const appendLogEntry = live(async (ctx, args) => {
	const severity = ['info', 'warn', 'error'].includes(args?.severity) ? args.severity : 'info'
	const message = typeof args?.message === 'string' && args.message.length > 0
		? args.message.slice(0, 200)
		: 'manually appended entry'
	const seq = await redis.redis.incr(SEQ_KEY)
	const entry = {
		id: 'log-' + seq,
		ts: Date.now(),
		severity,
		message,
		seq
	}
	await redis.redis.rpush(ENTRIES_KEY, JSON.stringify(entry))
	ctx.publish(TOPICS.demoPaginationLog, 'created', entry)
	return entry
})

/**
 * Paginated stream. Loader reads `ctx.cursor` (null on initial
 * subscribe, an opaque object on each `loadMore` call) and returns
 * the next slice plus an explicit `hasMore` flag and the next-page
 * cursor. The framework auto-detects the paginated shape (object
 * with `data`, `hasMore`, `cursor` keys) and propagates the
 * pagination metadata to the client store.
 */
export const logFeed = live.stream(
	TOPICS.demoPaginationLog,
	async (ctx) => {
		const offset = (ctx.cursor && typeof ctx.cursor === 'object' && Number.isInteger(ctx.cursor.offset))
			? Math.max(0, ctx.cursor.offset)
			: 0
		const [sliceRaws, totalLen] = await Promise.all([
			redis.redis.lrange(ENTRIES_KEY, offset, offset + PAGE_SIZE - 1),
			redis.redis.llen(ENTRIES_KEY)
		])
		const slice = []
		for (const raw of sliceRaws) {
			try { slice.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
		}
		const nextOffset = offset + slice.length
		const hasMore = nextOffset < totalLen
		return {
			data: slice,
			hasMore,
			cursor: hasMore ? { offset: nextOffset } : null
		}
	},
	{ merge: 'crud', key: 'id' }
)
