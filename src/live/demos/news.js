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
 *      friendly time scales over the spec's hour/day/lifetime so the
 *      visual diff is visible inside an e2e test run.
 *
 *  - live.derived(['demos:news:topk:lifetime', topic], fn) - server-side
 *      computed stream that recomputes when the lifetime aggregate
 *      publishes (1Hz under default firehose) or a new story arrives.
 *      Reads in-memory state to produce a four-field stats strip the
 *      page renders at the top.
 *
 * Storage is in-memory (demo only). Stories cap at STORY_CAP entries
 * with FIFO eviction; older entries publish a 'deleted' event so the
 * client list stays bounded.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { live, LiveError, combineCounts } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

const STORY_CAP = 24
const MAX_HEADLINE_LEN = 80
const MAX_SUMMARY_LEN = 200

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
 * Seed stories so the page is non-empty on first load and the firehose
 * has targets to pick from before any external publish fires. IDs are
 * stable strings so the aggregate's per-story counts persist across
 * dev-server restarts at runtime even if the seed list changes.
 */
const SEED_STORIES = [
	{ id: 'seed-aurora',  headline: 'Aurora launch clears final flight review', summary: 'Telemetry suite passes the last gate before Friday window.' },
	{ id: 'seed-crimson', headline: 'Crimson port reopens after ten-day blockade',  summary: 'Container traffic catches up overnight; carriers cite muted backlog.' },
	{ id: 'seed-echo',    headline: 'Echo Index closes at three-month high',         summary: 'Tech sector pulls the broader tape upward into the close.' },
	{ id: 'seed-glass',   headline: 'Glass Forest fire crews report 80% containment', summary: 'Cool front aided overnight push; full mop-up expected by week\'s end.' },
	{ id: 'seed-indigo',  headline: 'Indigo Tide power utility files rate adjustment', summary: 'Filing cites grid hardening costs; regulator opens 90-day comment period.' },
	{ id: 'seed-midnight', headline: 'Midnight Drift expansion adds two routes',     summary: 'Carrier announces twice-daily service to inland hub starting June.' }
]

/** Newest at the END (so .slice(-3) returns the three most recent). */
const stories = SEED_STORIES.map((s) => ({ ...s, source: 'seed', publishedAt: Date.now() }))

let totalViews = 0
let speed = 5

function nowIso() {
	return new Date().toISOString()
}

/**
 * GC pass for the stories list. Called from the firehose cron tick so
 * overflow eviction publishes 'deleted' events with a ctx in scope.
 *
 * The webhook transform path mutates `stories` but cannot publish
 * eviction events itself (no ctx); we instead let the cron tick reap
 * overflow within ~1s. Subscribers see a stale entry for at most one
 * tick before the 'deleted' fans out, which is fine for a demo.
 */
function gcStories(ctx) {
	while (stories.length > STORY_CAP) {
		const dropped = stories.shift()
		if (dropped) ctx.publish(TOPICS.demoNewsStories, 'deleted', { id: dropped.id })
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
function pickStoryId() {
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
export const myNewsState = live(async () => ({
	speed,
	storyCap: STORY_CAP,
	totalStories: stories.length,
	maxHeadlineLen: MAX_HEADLINE_LEN,
	maxSummaryLen: MAX_SUMMARY_LEN
}))

/**
 * Drop every webhook-sourced story. Seeded entries are kept (they are
 * not user content). The aggregate's per-story counts are left alone:
 * those decay out of the sliding (30s) and tumbling (1min) windows
 * naturally; the lifetime window retains ghost ids until next restart,
 * which is acceptable for a demo.
 */
export async function purge(ctx) {
	let dropped = 0
	for (let i = stories.length - 1; i >= 0; i--) {
		const s = stories[i]
		if (s.source !== 'seed') {
			ctx.publish(TOPICS.demoNewsStories, 'deleted', { id: s.id })
			stories.splice(i, 1)
			dropped++
		}
	}
	return { dropped, kept: stories.length }
}

/**
 * Set the firehose rate (0-50 events/sec). Capped well below the
 * default publish-rate threshold (5000/sec per topic).
 */
export const setSpeed = live(async (ctx, n) => {
	const num = Math.max(0, Math.min(50, Math.round(Number(n) || 0)))
	speed = num
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
	async () => stories.slice(),
	{ merge: 'crud', key: 'id' }
)

/**
 * Firehose. Every second the cron tick publishes `speed` 'viewed' events
 * into the source topic. The aggregate watches the same topic and
 * reduces them into per-window state. We also bump a module-scope
 * totalViews counter for the derived stream to read; the aggregate's
 * lifetime window holds the same value but per-story, and exposing the
 * scalar avoids re-summing it inside derived's recompute.
 *
 * Single-flight; cluster-singleton via configureCron({
 * leader }) wired in src/hooks.ws.js init.
 */
export const firehoseTick = live.cron('* * * * * *', TOPICS.demoNewsView, async (ctx) => {
	gcStories(ctx)
	if (speed <= 0) return
	for (let i = 0; i < speed; i++) {
		const storyId = pickStoryId()
		if (!storyId) break
		totalViews++
		ctx.publish(TOPICS.demoNewsView, 'viewed', { storyId, ts: Date.now() })
	}
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
 * in-memory state and the totalViews counter the firehose maintains.
 *
 * 250ms debounce so a burst of webhook publishes + the same-tick
 * aggregate publish coalesce into one recompute instead of three.
 */
export const newsStats = live.derived(
	['demos:news:topk:lifetime', TOPICS.demoNewsStories],
	async () => {
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
	transform(payload) {
		const id = typeof payload?.id === 'string' && payload.id.length > 0 ? payload.id : crypto.randomUUID()
		const headline = typeof payload?.headline === 'string' ? payload.headline.trim().slice(0, MAX_HEADLINE_LEN) : ''
		const summary = typeof payload?.summary === 'string' ? payload.summary.trim().slice(0, MAX_SUMMARY_LEN) : ''
		const publishedAt = typeof payload?.publishedAt === 'string' ? payload.publishedAt : nowIso()
		if (headline.length === 0) {
			throw new Error('headline required')
		}
		const story = { id, headline, summary, source: 'webhook', publishedAt: Date.parse(publishedAt) || Date.now() }
		// The framework auto-publishes the {event, data} we return to
		// the configured topic. Mutating `stories` here keeps the stream
		// loader + firehose's pickStoryId in sync immediately;
		// overflow eviction (with its 'deleted' fan-out) runs on the
		// next cron tick so it has a ctx in scope.
		stories.push(story)
		return { event: 'created', data: story }
	}
})
