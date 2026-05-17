/**
 * /demos/counter-resume - session resume + replay buffer demo.
 *
 * The pitch: drop the network for 10 seconds; counter keeps ticking
 * server-side; reconnect; UI catches up to the latest value with no
 * full refetch and no flicker. Every tick that happened during the
 * gap is delivered via the __replay:{topic} pipeline.
 *
 * Mechanism:
 * - A 1Hz `live.cron` ticks the counter. The 3-arg form auto-publishes
 *   the handler's return value as a 'set' event on the topic; the cron
 *   is cluster-singleton via `configureCron({ leader })` wired in
 *   src/hooks.ws.js so it fires exactly once across replicas.
 * - The counter itself lives in Redis (INCR) so the value is shared
 *   across replicas. A multi-replica deploy where the leader and the
 *   subscribing user are on different workers still produces a
 *   monotonic, agreed-upon counter.
 * - Cron publishes go through bus.wrap (cluster pub/sub) and the replay
 *   buffer when Redis is up; they fall through to direct local fanout
 *   when Redis is down (dev-without-Redis still delivers events; only
 *   the cluster-wide replay capture is lost).
 * - On reconnect the adapter's resume protocol presents the client's
 *   previous sessionId + lastSeenSeqs; the resume hook fills the gap
 *   via __replay frames.
 */

import { live } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { redis } from '$lib/server/redis'

const COUNTER_KEY = 'demos:counter-resume:counter'

/**
 * 1Hz cluster-singleton tick. INCR is atomic across replicas, so even
 * if leadership flips between workers the counter never regresses or
 * skips a value. The handler's return value is auto-published as 'set'
 * on the topic; subscribers see one monotonic stream.
 */
export const tick = live.cron('* * * * * *', TOPICS.demoCounterTick, async () => {
	const next = await redis.redis.incr(COUNTER_KEY)
	return next
})

export const count = live.stream(TOPICS.demoCounterTick, async () => {
	const v = await redis.redis.get(COUNTER_KEY)
	return v === null ? 0 : Number(v)
}, { merge: 'set', replay: true })

export const reset = live(async (ctx) => {
	await redis.redis.set(COUNTER_KEY, 0)
	ctx.publish(TOPICS.demoCounterTick, 'set', 0)
	return { count: 0 }
})
