// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/news - live newsroom showcasing four realtime primitives in one
 * page: a cron-driven view firehose, a three-window aggregate over that
 * firehose, a derived stat strip, and an HMAC-signed webhook bridging an
 * "external" publisher into the stories topic.
 *
 * The pitch: an editor types a headline + summary and clicks Publish.
 * The page asks the server for a signed payload, then POSTs that payload
 * directly to /api/demos/news/webhook. The webhook handler (live.webhook)
 * verifies the signature and publishes a `created` event to the stories
 * topic. Every subscribing tab sees the story land in the stories list,
 * the firehose biases toward recently-published stories so the new entry
 * climbs the trending leaderboards within a few seconds, and the derived
 * stats strip ticks up its totalStories / newestHeadline fields.
 *
 * Four primitives in one demo:
 *
 *  - live.webhook(topic, { verify, transform })
 *      - HTTP-to-stream bridge. Ships a `.handle({ body, headers, platform })`
 *      function the +server.js endpoint awaits. `verify` does HMAC-SHA256
 *      signature check (timing-safe) and parses the JSON body; `transform`
 *      shapes the verified payload into a `{ event, data }` pair the
 *      framework publishes to the configured topic.
 *
 *  - live.cron('* * * * * *', topic, fn) - 6-field cron,
 *      1Hz firehose. Emits `speed` view events per tick weighted toward
 *      the three most recently-published stories so a freshly-published
 *      headline crosses the trending leaderboard quickly.
 *
 *  - live.aggregate(source, reducers, { topic, windows }) - the
 *      windowed aggregate. One reducer (counts per story id), one compute
 *      (top-5), three windows: last30s sliding (3s hops), thisMinute
 *      tumbling (per-minute boundary), lifetime (never resets). Demo-
 *      friendly time scales over a production hour/day/lifetime so the
 *      visual diff is visible inside an e2e test run.
 *
 *  - live.derived(['demos:news:topk:lifetime', topic], fn) - server-side
 *      computed stream that recomputes when the lifetime aggregate
 *      publishes (1Hz under default firehose) or a new story arrives.
 *      Reads cluster-shared Redis state to produce a four-field stats
 *      strip the page renders at the top.
 *
 * Storage is cluster-shared via Redis (LIST + scalar counters) so the
 * leader-gated firehose, webhook-handler replicas, and subscribing
 * replicas all see the same view. Stories cap at STORY_CAP entries with
 * FIFO eviction (LPOP); seed entries are inserted once at first-boot
 * via a SETNX guard so multi-replica deploys do not multi-seed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { live, LiveError, combineCounts } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { redis } from '$lib/server/redis'

const STORY_CAP = 24
const MAX_HEADLINE_LEN = 80
const MAX_SUMMARY_LEN = 200
const DEFAULT_SPEED = 5

const STORIES_KEY = 'demos:news:stories'
const SEEDED_KEY = 'demos:news:seeded'
const SPEED_KEY = 'demos:news:speed'
const TOTAL_VIEWS_KEY = 'demos:news:totalViews'

/**
 * HMAC secret. Real deployments must override with DEMO_NEWS_WEBHOOK_SECRET.
 * Dev defaults to a hard-coded value so a fresh checkout works without env
 * setup; in production the fallback is fail-closed because shipping a known
 * static secret means any attacker can forge `created` stories.
 */
const WEBHOOK_SECRET = (() => {
	const fromEnv = process.env.DEMO_NEWS_WEBHOOK_SECRET
	if (fromEnv) return fromEnv
	if (process.env.NODE_ENV === 'production') {
		throw new Error(
			'DEMO_NEWS_WEBHOOK_SECRET must be set in production. The demo\'s ' +
			'static fallback is unsafe outside dev because it is checked into ' +
			'the repo - anyone could forge webhook events.'
		)
	}
	return 'demo-news-secret'
})()

/**
 * Initial stories the page shows before any webhook publishes. Seeded
 * once across the cluster via a SETNX guard so a multi-worker / multi-
 * replica deploy does not insert N copies of each seed.
 */
const SEED_STORIES = [
	{ id: 'seed-aurora',  headline: 'Aurora launch clears final flight review', summary: 'Telemetry suite passes the last gate before Friday window.' },
	{ id: 'seed-crimson', headline: 'Crimson port reopens after ten-day blockade',  summary: 'Container traffic catches up overnight; carriers cite muted backlog.' },
	{ id: 'seed-echo',    headline: 'Echo Index closes at three-month high',         summary: 'Tech sector pulls the broader tape upward into the close.' },
	{ id: 'seed-glass',   headline: 'Glass Forest fire crews report 80% containment', summary: 'Cool front aided overnight push; full mop-up expected by week\'s end.' },
	{ id: 'seed-indigo',  headline: 'Indigo Tide power utility files rate adjustment', summary: 'Filing cites grid hardening costs; regulator opens 90-day comment period.' },
	{ id: 'seed-midnight', headline: 'Midnight Drift expansion adds two routes',     summary: 'Carrier announces twice-daily service to inland hub starting June.' }
]

function nowIso() {
	return new Date().toISOString()
}

/**
 * One-shot cluster-wide seed. SETNX wins on exactly one worker across
 * the cluster; the winner replaces any existing list (defensive: a
 * crashed-mid-seed run would otherwise leave a partial list) and RPUSHes
 * all seeds. EX matches the boards' cleanup TTL so a fully idle deploy
 * lets Redis reclaim the key; the next boot re-seeds.
 */
async function seedIfNeeded() {
	try {
		const ok = await redis.redis.set(SEEDED_KEY, '1', 'NX', 'EX', 3600)
		if (ok !== 'OK') return
		const ts = Date.now()
		const pipeline = redis.redis.multi()
		pipeline.del(STORIES_KEY)
		for (const s of SEED_STORIES) {
			pipeline.rpush(STORIES_KEY, JSON.stringify({ ...s, source: 'seed', publishedAt: ts }))
		}
		await pipeline.exec()
	} catch {
		// Best-effort: Redis blip during boot just defers seeding to the
		// next worker. The demo can render with an empty list.
	}
}
seedIfNeeded()

async function getSpeed() {
	const v = await redis.redis.get(SPEED_KEY)
	if (v === null) return DEFAULT_SPEED
	const n = Number(v)
	return Number.isFinite(n) ? n : DEFAULT_SPEED
}

async function getTotalViews() {
	const v = await redis.redis.get(TOTAL_VIEWS_KEY)
	if (v === null) return 0
	const n = Number(v)
	return Number.isFinite(n) ? n : 0
}

/** Read all stories in chronological order (newest at the END). */
async function getStories() {
	const raw = await redis.redis.lrange(STORIES_KEY, 0, -1)
	const out = []
	for (const s of raw) {
		try { out.push(JSON.parse(s)) } catch { /* skip corrupt entry */ }
	}
	return out
}

/**
 * GC pass for the stories list. Called from the firehose cron tick so
 * overflow eviction publishes 'deleted' events with a ctx in scope. The
 * cron is cluster-singleton via configureCron({ leader }) so this only
 * runs on the leader replica; the LPOP + publish reaches all replicas
 * via the cluster bus.
 *
 * The webhook transform path RPUSHes but cannot publish eviction events
 * itself (no ctx); we instead let the cron tick reap overflow within
 * ~1s. Subscribers see a stale entry for at most one tick before the
 * 'deleted' fans out, which is fine for a demo.
 */
async function gcStories(ctx) {
	const len = await redis.redis.llen(STORIES_KEY)
	const excess = len - STORY_CAP
	if (excess <= 0) return
	for (let i = 0; i < excess; i++) {
		const raw = await redis.redis.lpop(STORIES_KEY)
		if (!raw) break
		try {
			const dropped = JSON.parse(raw)
			ctx.publish(TOPICS.demoNewsStories, 'deleted', { id: dropped.id })
		} catch { /* corrupt entry already popped; nothing more to do */ }
	}
}

/**
 * Bias the firehose toward the three most recently-added stories so a
 * freshly-published headline climbs the trending leaderboard within a
 * few firehose ticks. Without this bias the editorial loop ("publish a
 * story, watch it trend") doesn't read at default speed=5.
 *
 *  - 50% combined weight on the newest 3 stories
 *  - 50% spread uniformly over everything older (or over the seed pool
 *    if there are fewer than 3 stories total)
 */
function pickStoryId(stories) {
	if (stories.length === 0) return null
	const r = Math.random()
	const newest = stories.slice(-3)
	if (r < 0.5 && newest.length > 0) {
		return newest[Math.floor(Math.random() * newest.length)].id
	}
	const older = stories.slice(0, Math.max(0, stories.length - 3))
	const pool = older.length > 0 ? older : stories
	return pool[Math.floor(Math.random() * pool.length)].id
}

/**
 * Page-load probe. Returns the current speed plus the seed/runtime
 * stories so the page renders without a flash of empty state on first
 * mount. The stories stream is the source of truth thereafter.
 */
export const myNewsState = live(async () => {
	const [speed, len] = await Promise.all([
		getSpeed(),
		redis.redis.llen(STORIES_KEY)
	])
	return {
		speed,
		storyCap: STORY_CAP,
		totalStories: len,
		maxHeadlineLen: MAX_HEADLINE_LEN,
		maxSummaryLen: MAX_SUMMARY_LEN
	}
})

/**
 * Drop every webhook-sourced story. Seeded entries are kept (they are
 * not user content). The aggregate's per-story counts are left alone:
 * those decay out of the sliding (30s) and tumbling (1min) windows
 * naturally; the lifetime window retains ghost ids until next restart,
 * which is acceptable for a demo.
 *
 * LREM removes by exact-value match. JSON.stringify is deterministic
 * for the same property order, so the raw LRANGE strings round-trip
 * back to identical removals. Race-safe against concurrent webhook
 * RPUSHes: a story that lands between our read and the LREM survives,
 * which is the expected purge semantics.
 */
export async function purge(ctx) {
	const raws = await redis.redis.lrange(STORIES_KEY, 0, -1)
	let dropped = 0
	let kept = 0
	for (const raw of raws) {
		let entry
		try { entry = JSON.parse(raw) } catch { continue }
		if (entry.source === 'seed') { kept++; continue }
		const removed = await redis.redis.lrem(STORIES_KEY, 1, raw)
		if (removed > 0) {
			ctx.publish(TOPICS.demoNewsStories, 'deleted', { id: entry.id })
			dropped++
		}
	}
	return { dropped, kept }
}

/**
 * The firehose rate as live shared state, rather than a number each page
 * sampled once on the way in.
 *
 * The simulation was already shared: `setSpeed` writes the rate to Redis and
 * the cron reads it from there, so every browser's feed really did speed up
 * together. Only the READOUT disagreed - a page learned the rate at load and
 * was never told it changed, so two browsers sat at different numbers above
 * an identical stream and reloading looked like the fix. The rate now travels
 * the way every other shared value in these demos does.
 *
 * The loader returns the same shape the setter publishes, so a subscriber
 * cannot tell the initial read from a later change.
 */
export const newsControls = live.stream(
	TOPICS.demoNewsControl,
	async () => ({ speed: await getSpeed() }),
	{ merge: 'set' }
)

/**
 * Set the firehose rate (0-50 events/sec). Capped well below the
 * default publish-rate threshold (5000/sec per topic).
 */
export const setSpeed = live(async (ctx, n) => {
	const num = Math.max(0, Math.min(50, Math.round(Number(n) || 0)))
	await redis.redis.set(SPEED_KEY, num)
	// Published after the write, so a subscriber that reacts by re-reading
	// cannot observe the old value.
	ctx.publish(TOPICS.demoNewsControl, 'set', { speed: num })
	return { ok: true, speed: num }
})

/**
 * Sign a publish payload server-side so the page can POST a webhook-
 * shaped request to /api/demos/news/webhook without ever holding the
 * HMAC secret. This RPC is the demo's stand-in for a third-party CMS
 * preparing a Stripe-style signed webhook - in production the signer
 * is the external system itself, not your own server.
 *
 * Returns the raw JSON body + the x-news-signature header value so the
 * page can fetch() the webhook endpoint with both. The headline +
 * summary are validated and length-clipped server-side before signing
 * so the eventual stored entry stays bounded.
 */
export const signPublish = live(async (ctx, args) => {
	const headline = typeof args?.headline === 'string' ? args.headline.trim() : ''
	const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
	if (headline.length === 0) throw new LiveError('VALIDATION', 'headline required')

	const payload = {
		id: crypto.randomUUID(),
		headline: headline.slice(0, MAX_HEADLINE_LEN),
		summary: summary.slice(0, MAX_SUMMARY_LEN),
		publishedAt: nowIso()
	}
	const body = JSON.stringify(payload)
	const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')
	return { body, signature }
})

/**
 * Live stream of the stories list. Newest first on the wire is awkward
 * with `merge: 'crud'` (the framework treats the list as keyed by id,
 * not order-significant), so the page sorts client-side by publishedAt
 * descending. Capped server-side at STORY_CAP with FIFO eviction.
 */
export const newsStories = live.stream(
	TOPICS.demoNewsStories,
	async () => getStories(),
	{ merge: 'crud', key: 'id' }
)

/**
 * Firehose. Every second the cron tick publishes `speed` 'viewed' events
 * into the source topic. The aggregate watches the same topic and
 * reduces them into per-window state. We also bump a Redis-shared
 * totalViews counter for the derived stream to read; the aggregate's
 * lifetime window holds the same value but per-story, and exposing the
 * scalar avoids re-summing it inside derived's recompute.
 *
 * Single-flight; cluster-singleton via configureCron({ leader }) wired
 * in src/hooks.ws.js init. INCRBY batches the view increment so a tick
 * at speed=50 issues one Redis op instead of fifty.
 */
export const firehoseTick = live.cron('* * * * * *', TOPICS.demoNewsView, async (ctx) => {
	await gcStories(ctx)
	const speed = await getSpeed()
	if (speed <= 0) return
	const stories = await getStories()
	if (stories.length === 0) return
	const ts = Date.now()
	let viewed = 0
	for (let i = 0; i < speed; i++) {
		const storyId = pickStoryId(stories)
		if (!storyId) break
		ctx.publish(TOPICS.demoNewsView, 'viewed', { storyId, ts })
		viewed++
	}
	if (viewed > 0) await redis.redis.incrby(TOTAL_VIEWS_KEY, viewed)
})

/**
 * Three trending leaderboards from one firehose. Same shape as
 * /demos/topk: one `counts` reducer, one `top` compute, multiple
 * windows. Derived output topics are `demos:news:topk:last30s`,
 * `demos:news:topk:thisMinute`, `demos:news:topk:lifetime`.
 *
 * `combine: combineCounts` is mandatory on the reducer for the sliding
 * window (hop-bucket merge requirement). `top` has no `reduce`
 * so it does not need `combine`.
 */
export const trending = live.aggregate(TOPICS.demoNewsView, {
	counts: {
		init: () => ({}),
		reduce: (acc, event, data) => {
			if (event !== 'viewed') return acc
			return { ...acc, [data.storyId]: (acc[data.storyId] ?? 0) + 1 }
		},
		combine: combineCounts
	},
	top: {
		compute: (state) => {
			const entries = Object.entries(state.counts ?? {})
			entries.sort((a, b) => b[1] - a[1])
			return entries.slice(0, 5).map(([storyId, count]) => ({ storyId, count }))
		}
	}
}, {
	topic: TOPICS.demoNewsTopkBase,
	windows: {
		last30s:    { type: 'sliding',  durationMs: 30_000, slideMs: 3_000 },
		thisMinute: { type: 'tumbling', period: 'minute' },
		lifetime:   { type: 'lifetime' }
	}
})

/**
 * Derived stats strip. Recomputes when the lifetime aggregate publishes
 * (1Hz under the default firehose) or when a new story arrives. Reads
 * cluster-shared Redis state so the value is the same on every replica.
 *
 * 250ms debounce so a burst of webhook publishes + the same-tick
 * aggregate publish coalesce into one recompute instead of three.
 */
export const newsStats = live.derived(
	['demos:news:topk:lifetime', TOPICS.demoNewsStories],
	async () => {
		const [stories, totalViews] = await Promise.all([
			getStories(),
			getTotalViews()
		])
		const newest = stories[stories.length - 1] ?? null
		return {
			totalStories: stories.length,
			totalViews,
			newestId: newest?.id ?? null,
			newestHeadline: newest?.headline ?? null,
			newestPublishedAt: newest?.publishedAt ?? null
		}
	},
	{ debounce: 250 }
)

/**
 * Webhook bridge. The +server.js endpoint at /api/demos/news/webhook
 * forwards the raw body + headers here; we verify the HMAC signature,
 * parse the JSON, and shape it into a `{ event, data }` pair the
 * framework publishes to TOPICS.demoNewsStories.
 *
 * Verify failures throw - the framework returns 400 in that case.
 * Returning null from transform would silently ignore an event; we
 * never want that here so we always return a `created` shape.
 */
export const newsWebhook = live.webhook(TOPICS.demoNewsStories, {
	verify({ body, headers }) {
		const sig = headers['x-news-signature']
		if (typeof sig !== 'string' || sig.length === 0) {
			throw new Error('missing x-news-signature header')
		}
		const expected = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')
		// timingSafeEqual requires equal-length buffers; mismatch on length
		// is itself a signature failure so we short-circuit before the
		// constant-time compare.
		if (sig.length !== expected.length) throw new Error('invalid signature')
		const a = Buffer.from(sig, 'utf8')
		const b = Buffer.from(expected, 'utf8')
		if (!timingSafeEqual(a, b)) throw new Error('invalid signature')
		return JSON.parse(body)
	},
	async transform(payload) {
		const id = typeof payload?.id === 'string' && payload.id.length > 0 ? payload.id : crypto.randomUUID()
		const headline = typeof payload?.headline === 'string' ? payload.headline.trim().slice(0, MAX_HEADLINE_LEN) : ''
		const summary = typeof payload?.summary === 'string' ? payload.summary.trim().slice(0, MAX_SUMMARY_LEN) : ''
		const publishedAt = typeof payload?.publishedAt === 'string' ? payload.publishedAt : nowIso()
		if (headline.length === 0) {
			throw new Error('headline required')
		}
		const story = { id, headline, summary, source: 'webhook', publishedAt: Date.parse(publishedAt) || Date.now() }
		// RPUSH appends to the cluster-shared list so the next firehose
		// tick's pickStoryId on the leader replica sees the new story,
		// AND new subscribers reading via getStories see it too. Overflow
		// eviction (with its 'deleted' fan-out) runs on the next cron
		// tick so it has a ctx in scope.
		await redis.redis.rpush(STORIES_KEY, JSON.stringify(story))
		return { event: 'created', data: story }
	}
})
