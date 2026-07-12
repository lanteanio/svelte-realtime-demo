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
	const key = roundSetKey(currentMinute())
	await redis.redis.multi().sadd(key, ctx.user.id).expire(key, 180).exec()
	ctx.publish(TOPICS.demoPrivacyMoods, 'submitted', { userId: ctx.user.id, score: s })
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
		resetInSeconds: 60 - Math.floor((Date.now() / 1000) % 60)
	}
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
