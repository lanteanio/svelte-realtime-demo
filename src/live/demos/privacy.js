// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/privacy - k-anonymity + differential privacy on aggregates.
 *
 * The pitch: a "team mood" average, published twice from the same
 * source events. The RAW aggregate moves on every submission and shows
 * exact values. The PROTECTED aggregate declares `privacy: { k: 3,
 * strategy: 'hybrid' }`: it does not publish until at least 3 DISTINCT
 * contributors have fed the current window, and when it does publish,
 * calibrated zero-mean Laplace noise rides every numeric field. Below
 * k the protected card simply does not move - suppression holds the
 * last published value rather than emitting a null or a marker,
 * because "the cohort just dropped below k" is itself the signal
 * k-anonymity exists to hide.
 *
 * Privacy is declaration-time: the raw-vs-protected comparison is two
 * aggregate exports over one source topic, identical reducers, one
 * extra `privacy` option. Production would ship only the protected
 * one; the raw aggregate exists here purely so the difference is
 * visible.
 *
 * Both aggregates run a per-minute tumbling window ("round") instead
 * of the single-state form. Deliberate: a single-state aggregate's
 * contributor cohort never resets for the process lifetime, so on a
 * long-running deployment the k-gate would be permanently passed after
 * the third visitor ever and the held state - the whole point of the
 * demo - would never be seen again. A tumbling window re-earns its k
 * every minute (per the framework contract: each window has its own
 * cohort, and a fresh window draws fresh noise).
 *
 * Noise determinism: the noise offset is seeded by (topic, window), so
 * every cluster replica - each independently reducing the same source
 * firehose - emits identical values. A per-node offset would let a
 * client reconnecting to another replica difference the two and
 * recover the truth.
 *
 * The distinct-contributor hint on the page comes from a server-side
 * Redis set keyed by the current minute (self-expiring, never sent to
 * the wire as ids). The k-cohort itself is framework-internal; the
 * hint exists only because this demo deliberately exposes the raw side
 * for comparison.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { redis } from '$lib/server/redis'
import { TOPICS } from '$lib/server/topics'

const K = 3

const roundSetKey = (minute) => `demos:privacy:contributors:${minute}`
const currentMinute = () => Math.floor(Date.now() / 60_000)

/**
 * Has THIS process's protected aggregate ever actually published?
 *
 * Deliberately per-process, and deliberately not in Redis. The value this
 * gates - the aggregate's last wire state - is itself per-process in-memory
 * state that resets to an un-noised zero seed on every start. A cluster-wide
 * durable flag would outlive the value it describes: after any replica
 * restart within the flag's lifetime, a visitor routed to the restarted
 * replica would be told "published" while being shown the zero seed, which is
 * exactly the reading the gate exists to prevent. The RPC and the aggregate
 * subscription share one socket, so a client always reads this flag from the
 * same process that serves it the value.
 */
let everPublishedHere = false

/**
 * Submit a mood score (1..5). Publishes into the source topic both
 * aggregates watch; the event carries the contributor identity for the
 * k-anonymity cohort. Clients never subscribe to the source topic -
 * only to the aggregate outputs - so the per-event userId stays
 * server-side.
 */
export const submitMood = live(async (ctx, score) => {
	const s = Number(score)
	if (!Number.isInteger(s) || s < 1 || s > 5) {
		throw new LiveError('VALIDATION', 'score must be an integer 1..5')
	}
	// Round-scoped distinct-contributor hint for the page. Server-side
	// only; the set self-expires two rounds later.
	// Round-scoped distinct-contributor hint for the page, plus the post-add
	// cardinality from the same atomic turn - SADD/EXPIRE/SCARD in one MULTI
	// saves a round trip and cannot observe a torn count.
	const key = roundSetKey(currentMinute())
	const results = await redis.redis.multi().sadd(key, ctx.user.id).expire(key, 180).scard(key).exec()
	const distinct = Number(results?.[2]?.[1] ?? 0)
	ctx.publish(TOPICS.demoPrivacyMoods, 'submitted', { userId: ctx.user.id, score: s })
	// The protected aggregate publishes once a round reaches k, but the wire
	// cannot tell a fresh subscriber "never published" apart from "held" (the
	// initial serve is a zero seed). Record the k-crossing so the page can
	// render the held-empty state honestly. Set after the publish that causes
	// it, so the flag never claims a publish that has not been issued.
	if (distinct >= K) everPublishedHere = true
	return { ok: true }
})

/**
 * Distinct-contributor count for the current round, plus k and the
 * seconds until the round (and both windows) reset. Drives the "n of k
 * contributors" hint under the protected card.
 */
export const roundInfo = live(async () => {
	const distinct = await redis.redis.scard(roundSetKey(currentMinute()))
	return {
		distinct,
		k: K,
		everPublished: everPublishedHere,
		resetInSeconds: 60 - Math.floor((Date.now() / 1000) % 60)
	}
})

/**
 * Bring two SIMULATED contributors into the current round so a solo
 * visitor can reach the demo's payoff.
 *
 * Crossing k needs three DISTINCT contributors, and the page's only
 * previous remedy was "open two more browsers" - unreachable on a phone,
 * where incognito windows cannot share a screen, which is most of the
 * traffic this demo gets. These companions are not a shortcut around the
 * privacy layer: they publish ordinary 'submitted' events under their own
 * distinct ids, so the aggregate's own contributor rule counts them and
 * the protected output crosses k through exactly the mechanism the page
 * is teaching. Nothing about the k gate, the noise, or the hold is
 * bypassed - the visitor is simply no longer required to own three
 * devices to watch it work.
 *
 * The ids are round-scoped and openly synthetic so they can never be
 * mistaken for people, and the page labels the control as simulated.
 */
export const inviteCompanions = live(async (ctx) => {
	const minute = currentMinute()
	const key = roundSetKey(minute)
	const companions = [
		{ userId: `demo-companion-a:${minute}`, score: 4 },
		{ userId: `demo-companion-b:${minute}`, score: 2 }
	]
	const tx = redis.redis.multi()
	for (const c of companions) tx.sadd(key, c.userId)
	tx.expire(key, 180)
	tx.scard(key)
	const results = await tx.exec()
	const distinct = Number(results?.[results.length - 1]?.[1] ?? 0)
	for (const c of companions) {
		ctx.publish(TOPICS.demoPrivacyMoods, 'submitted', { userId: c.userId, score: c.score })
	}
	if (distinct >= K) everPublishedHere = true
	return { added: companions.length, distinct }
})

/**
 * Shared reducer shape for both aggregates. A factory (not a shared
 * object) so each aggregate owns its own config instance.
 */
function moodReducers() {
	return {
		sum: {
			init: () => 0,
			reduce: (acc, event, data) => event === 'submitted' ? acc + data.score : acc
		},
		n: {
			init: () => 0,
			reduce: (acc, event) => event === 'submitted' ? acc + 1 : acc
		},
		avg: {
			compute: (state) => state.n > 0 ? state.sum / state.n : 0
		}
	}
}

/**
 * RAW: exact values, publishes on every submission. Exists only so the
 * page can show what the protected aggregate is hiding.
 */
export const rawMood = live.aggregate(TOPICS.demoPrivacyMoods, moodReducers(), {
	topic: TOPICS.demoPrivacyAggRaw,
	windows: {
		round: { type: 'tumbling', period: 'minute' }
	}
})

/**
 * PROTECTED: same reducers, same window, plus the privacy layer.
 * 'hybrid' = k-anonymity suppression AND differential-privacy noise:
 * held until >= 3 distinct contributors this round (a fresh subscriber
 * sees the held value too, never the live below-k state), then
 * published with Laplace noise at epsilon 1.0 on every numeric field.
 */
export const privateMood = live.aggregate(TOPICS.demoPrivacyMoods, moodReducers(), {
	topic: TOPICS.demoPrivacyAggPrivate,
	windows: {
		round: { type: 'tumbling', period: 'minute' }
	},
	privacy: {
		k: K,
		epsilon: 1.0,
		noise: 'laplace',
		strategy: 'hybrid',
		contributor: (d) => d.userId
	}
})
