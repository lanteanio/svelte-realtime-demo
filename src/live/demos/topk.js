// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/topk - four leaderboards from one event firehose, declared in
 * one config via `live.aggregate({ windows })`.
 *
 * The pitch: one source topic, one reducer, one `windows` block that
 * spawns four parallel state slices with their own output topics.
 * Crank the speed slider; watch sliding adjust immediately while
 * tumbling resets sharply at the minute boundary and lifetime drifts
 * up monotonically. The visual delta between window types IS the
 * pitch.
 *
 * Three primitives in one page:
 *
 *  - live.aggregate({ windows }) - new. Declarative window
 *    config replaces the four-aggregates-and-hand-rolled-bucketing
 *    dance every prior leaderboard / trending surface had to write.
 *    Three window types ship: lifetime (never resets), tumbling
 *    (boundary-anchored via period: minute / hour / daily / monthly,
 *    or durationMs + anchor for arbitrary fixed periods), and
 *    sliding (hop-window with durationMs + slideMs).
 *
 *  - combineCounts - one of the new built-in `combine` helpers
 *    that ship with (alongside combineSum / combineMax /
 *    combineMin / combineMerge). Required on every reducer that
 *    has `reduce` when used with a sliding window, since hop-bucket
 *    state has to merge across N buckets at compute time and the
 *    framework can't infer the merge for non-trivial state shapes.
 *    combineCounts handles `Record<string, number>` aggregation,
 *    which is exactly what our per-item counter produces.
 *
 *  - live.cron('* * * * * *') - 1Hz firehose tick driving N events
 *    per second based on the current `speed` setting. Demos the
 *    6-field cron alongside the windowed
 *    aggregate; the two compose without ceremony.
 *
 * Demo-friendly time scales (10s / 1min / minute / lifetime) instead
 * of a production 10min / daily / monthly / lifetime - visible diff in
 * test-runtime instead of "wait until midnight." Educational pitch is
 * identical; values are tunable.
 */

import { live, LiveError, combineCounts } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { redis } from '$lib/server/redis'

/** Pool of 12 visually distinct items competing for the leaderboards. */
const ITEMS = [
	{ id: 'aurora',   name: 'Aurora Flux' },
	{ id: 'crimson',  name: 'Crimson Loop' },
	{ id: 'echo',     name: 'Echo Garden' },
	{ id: 'glass',    name: 'Glass Forest' },
	{ id: 'indigo',   name: 'Indigo Tide' },
	{ id: 'midnight', name: 'Midnight Drift' },
	{ id: 'neon',     name: 'Neon Pillow' },
	{ id: 'quantum',  name: 'Quantum Bloom' },
	{ id: 'sunlit',   name: 'Sunlit Vagrant' },
	{ id: 'tidal',    name: 'Tidal Murmur' },
	{ id: 'velvet',   name: 'Velvet Pixel' },
	{ id: 'amber',    name: 'Amber Drift' }
]

const VALID_BIAS = new Set(['uniform', 'hot', 'monopoly'])
const DEFAULT_SPEED = 5
const DEFAULT_BIAS = 'uniform'

/**
 * Server-side controls live in Redis so the slider is cluster-shared:
 * setSpeed / setBias RPCs may land on any replica, and the leader-gated
 * firehose cron may fire on a different replica - both ends see the
 * same value within one round-trip.
 */
const SPEED_KEY = 'demos:topk:speed'
const BIAS_KEY = 'demos:topk:bias'

async function getSpeed() {
	const v = await redis.redis.get(SPEED_KEY)
	if (v === null) return DEFAULT_SPEED
	const n = Number(v)
	return Number.isFinite(n) ? n : DEFAULT_SPEED
}

async function getBias() {
	const v = await redis.redis.get(BIAS_KEY)
	return typeof v === 'string' && VALID_BIAS.has(v) ? v : DEFAULT_BIAS
}

/**
 * Bias weights determine how the firehose picks items.
 *
 *  - uniform: every item equal probability (1/12 ~= 8.3% each)
 *  - hot:     top 3 items get 60% combined; rest split the 40%
 *  - monopoly: one item dominates with 75%; rest split the 25%
 */
function pickItem(bias) {
	const r = Math.random()
	const N = ITEMS.length
	if (bias === 'uniform') {
		return ITEMS[Math.floor(r * N)].id
	}
	if (bias === 'hot') {
		// Aurora 25%, Crimson 20%, Echo 15%, rest split 40% over 9 items
		if (r < 0.25) return 'aurora'
		if (r < 0.45) return 'crimson'
		if (r < 0.60) return 'echo'
		const rest = ITEMS.slice(3)
		return rest[Math.floor((r - 0.60) / 0.40 * rest.length)].id
	}
	// monopoly
	if (r < 0.75) return 'midnight'
	const rest = ITEMS.filter((it) => it.id !== 'midnight')
	return rest[Math.floor((r - 0.75) / 0.25 * rest.length)].id
}

/**
 * Set the firehose rate. Capped at 50 events/sec so a runaway slider
 * doesn't trip the publish-rate metric (default threshold 5000/sec
 * applies per-topic; 50/sec is well below).
 */
export const setSpeed = live(async (ctx, n) => {
	const num = Math.max(0, Math.min(50, Math.round(Number(n) || 0)))
	await redis.redis.set(SPEED_KEY, num)
	// Published after the write, so a subscriber that reacts by re-reading
	// cannot observe the old value.
	ctx.publish(TOPICS.demoTopkControl, 'set', { speed: num, bias: await getBias() })
	return { ok: true, speed: num }
})

/**
 * Set the firehose bias. Validation is strict so a typo lands as a
 * 4xx-shaped error on the client instead of silently leaving the bias
 * at its previous value.
 */
export const setBias = live(async (ctx, b) => {
	if (typeof b !== 'string' || !VALID_BIAS.has(b)) {
		throw new LiveError('VALIDATION', 'invalid bias')
	}
	await redis.redis.set(BIAS_KEY, b)
	ctx.publish(TOPICS.demoTopkControl, 'set', { speed: await getSpeed(), bias: b })
	return { ok: true, bias: b }
})

/**
 * The firehose controls as live shared state, rather than values each page
 * sampled once on the way in.
 *
 * The simulation was already shared: the setters write to Redis and the cron
 * reads from there, so every browser's stream really did change together.
 * Only the READOUT disagreed - a page learned speed and bias at load and was
 * never told they changed, so two browsers sat at different settings above an
 * identical firehose and reloading looked like the fix.
 *
 * Both values ride one topic because they describe one control panel: a
 * subscriber that learned about a bias change but not the rate beside it would
 * be a smaller version of the same bug. The loader returns the same shape the
 * setters publish, so a subscriber cannot tell the initial read from a change.
 */
export const topkControls = live.stream(
	TOPICS.demoTopkControl,
	async () => ({ speed: await getSpeed(), bias: await getBias() }),
	{ merge: 'set' }
)

/**
 * Page-load state probe. Returns the current speed/bias so the page
 * renders the right slider position + active bias button without a
 * round-trip flicker.
 */
export const myTopkState = live(async () => {
	const [speed, bias] = await Promise.all([getSpeed(), getBias()])
	return { speed, bias, items: ITEMS }
})

/**
 * Firehose. Every second the cron tick publishes `speed` 'viewed'
 * events into the source topic. The aggregate watches the same topic
 * and reduces them into per-window state.
 *
 * Single-flight - a slow tick doesn't overlap with itself.
 * In single-instance dev (no Redis configured) the leader check via
 * configureCron returns truthy, so the firehose runs. In a multi-
 * worker cluster, only the leader fires; non-leaders skip with
 * cron{status:'not-leader'} (set up in hooks.ws.js init).
 */
export const firehoseTick = live.cron('* * * * * *', TOPICS.demoTopkEvent, async (ctx) => {
	const speed = await getSpeed()
	if (speed <= 0) return
	const bias = await getBias()
	for (let i = 0; i < speed; i++) {
		ctx.publish(TOPICS.demoTopkEvent, 'viewed', { itemId: pickItem(bias), ts: Date.now() })
	}
})

/**
 * The headline declaration. One reducer (counts per item), one
 * compute (top-5 derived from counts), four window slices.
 *
 * - last10s:    sliding 10s with 1s hops - 10 buckets in the ring.
 *               Most twitchy view; shows immediate effect of speed
 *               and bias changes.
 * - last1min:   sliding 60s with 5s hops - 12 buckets. Smoother;
 *               averages out the noise in last10s.
 * - thisMinute: tumbling on minute boundary - resets to {} every
 *               wall-clock minute. Sharp drop at the boundary; counts
 *               climb back up over the next minute.
 * - lifetime:   monotonic counter; never resets. The "hall of fame"
 *               view; drifts up forever.
 *
 * Output topics are derived as `${topic}:${windowName}`:
 *   demos:topk:last10s, demos:topk:last1min,
 *   demos:topk:thisMinute, demos:topk:lifetime
 *
 * The vite plugin generates a namespace export so the page imports
 * `trending` and accesses `trending.last10s.subscribe(...)` etc.
 *
 * `combine: combineCounts` is mandatory on the `counts` reducer for
 * the sliding windows - the framework needs a deterministic way to
 * merge hop-bucket states into the full-window state. The built-in
 * helper handles `Record<string, number>` summation. `top` has no
 * `reduce` (only `compute`), so it doesn't need `combine`.
 */
export const trending = live.aggregate(TOPICS.demoTopkEvent, {
	counts: {
		init: () => ({}),
		reduce: (acc, event, data) => {
			if (event !== 'viewed') return acc
			return { ...acc, [data.itemId]: (acc[data.itemId] ?? 0) + 1 }
		},
		combine: combineCounts
	},
	top: {
		compute: (state) => {
			const entries = Object.entries(state.counts ?? {})
			entries.sort((a, b) => b[1] - a[1])
			return entries.slice(0, 5).map(([itemId, count]) => ({ itemId, count }))
		}
	}
}, {
	topic: TOPICS.demoTopkBase,
	windows: {
		last10s:    { type: 'sliding',  durationMs: 10_000, slideMs: 1_000 },
		last1min:   { type: 'sliding',  durationMs: 60_000, slideMs: 5_000 },
		thisMinute: { type: 'tumbling', period: 'minute' },
		lifetime:   { type: 'lifetime' }
	}
})
