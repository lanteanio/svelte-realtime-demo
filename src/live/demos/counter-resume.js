/**
 * /demos/counter-resume -- session resume + replay buffer demo.
 *
 * The pitch: drop the network for 10 seconds; counter keeps ticking
 * server-side; reconnect; UI catches up to the latest value with no
 * full refetch and no flicker. Every tick that happened during the
 * gap is delivered via the __replay:{topic} pipeline.
 *
 * Mechanism:
 * - Server-side setInterval ticks the counter every second.
 * - Each tick publishes on `demos:counter:tick` via the captured
 *   platform reference (the bus-wrapped + replay-aware platform from
 *   ctx.platform, see src/hooks.ws.js wrapWithReplay).
 * - Publishes are stored in the Redis replay buffer when Redis is up,
 *   and fall through to direct local fanout when it is down (so dev
 *   without Redis still delivers events; only the cluster-wide replay
 *   capture is lost).
 * - On reconnect the adapter's resume protocol presents the client's
 *   previous sessionId + lastSeenSeqs; the resume hook fills the gap
 *   via __replay frames.
 *
 * The ticker arms lazily from the stream's loader on first subscribe.
 * Putting it at module top-level would not work -- the module loads
 * via the realtime registry's lazy import only when a client first
 * touches the stream, and we need a captured platform to publish to.
 */

import { live } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

let counter = 0
let platform = null
let timer = null

function arm(p) {
	if (platform) return
	platform = p
	timer = setInterval(() => {
		counter += 1
		platform.publish(TOPICS.demoCounterTick, 'set', counter)
	}, 1000)
}

export const count = live.stream(TOPICS.demoCounterTick, async (ctx) => {
	arm(ctx.platform)
	return counter
}, { merge: 'set', replay: true })

export const reset = live(async (ctx) => {
	counter = 0
	ctx.publish(TOPICS.demoCounterTick, 'set', 0)
	return { count: 0 }
})
