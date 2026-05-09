/**
 * /demos/pressure -- live admission-shedding control panel.
 *
 * The pitch: the destroyer test (e2e/destroyer-standalone.js) ramps
 * 10K connections to find the ceiling. With Phase 3.1's two-tier
 * admission control wired, the server sheds cleanly long before it
 * falls over. This page makes that visible: a live readout of
 * `platform.pressure`, an in-page load generator, and a list of
 * recent shed decisions.
 *
 * Streams:
 * - `demos:pressure:tick` -- 500ms heartbeat publishing the current
 *   pressure snapshot. `merge: 'set'`. Self-arms on first subscribe
 *   the same way /demos/counter-resume does (no static import of
 *   live modules from hooks.ws.js).
 * - `demos:pressure:shed` -- crud merge of recent shed decisions.
 *   Capped at 50 entries client-side via `max`.
 *
 * RPCs:
 * - `generateLoad(count)` -- publishes `count` no-op events to
 *   `demos:pressure:noise` (capped at 5000 to keep the demo from
 *   self-DOSing). Checks `ctx.shed('background')` after; if shed,
 *   publishes a real shed event with the actual pressure reason.
 * - `simulateShed()` -- always publishes a synthetic shed event,
 *   regardless of actual pressure. Lets the page demonstrate the
 *   surface even when the demo's load isn't enough to drive
 *   PUBLISH_RATE past the admission threshold.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

const TICK_INTERVAL_MS = 500
const SHED_MAX = 50
const LOAD_CAP = 5000

let armed = false
let lastSnapshot = null
const shedLog = []

function armTicker(platform) {
	if (armed) return
	armed = true
	setInterval(() => {
		const snap = platform.pressure
		// Snapshot getter returns a fresh object each call; safe to
		// publish directly. Ignore topPublishers in the demo wire
		// shape -- the readout only needs the four scalar fields.
		const payload = {
			active: !!snap.active,
			subscriberRatio: snap.subscriberRatio ?? 0,
			publishRate: snap.publishRate ?? 0,
			memoryMB: snap.memoryMB ?? 0,
			reason: snap.reason ?? 'NONE',
			ts: Date.now()
		}
		lastSnapshot = payload
		platform.publish(TOPICS.demoPressureTick, 'set', payload)
	}, TICK_INTERVAL_MS)
}

export const pressureSnapshot = live.stream(
	TOPICS.demoPressureTick,
	async (ctx) => {
		armTicker(ctx.platform)
		return lastSnapshot ?? null
	},
	{ merge: 'set' }
)

export const shedEvents = live.stream(
	TOPICS.demoPressureShed,
	async () => shedLog.slice(),
	{ merge: 'crud', key: 'id' }
)

function pushShed(ctx, entry) {
	shedLog.push(entry)
	if (shedLog.length > SHED_MAX) shedLog.shift()
	ctx.publish(TOPICS.demoPressureShed, 'created', entry)
}

export const generateLoad = live(async (ctx, count) => {
	const safe = Math.min(Math.max(parseInt(count) || 100, 1), LOAD_CAP)
	const messages = Array.from({ length: safe }, (_, i) => ({
		topic: TOPICS.demoPressureNoise,
		event: 'tick',
		data: { i, ts: Date.now() }
	}))
	ctx.platform.publishBatched(messages)

	// Did the burst push us into a shed-able state?
	if (ctx.shed('background')) {
		const snap = ctx.platform.pressure
		pushShed(ctx, {
			id: crypto.randomUUID(),
			ts: Date.now(),
			class: 'background',
			handler: 'generateLoad',
			reason: snap.reason,
			source: 'real'
		})
	}
	return { generated: safe }
})

export const simulateShed = live(async (ctx) => {
	pushShed(ctx, {
		id: crypto.randomUUID(),
		ts: Date.now(),
		class: 'background',
		handler: 'simulateShed',
		reason: 'PUBLISH_RATE',
		source: 'simulated'
	})
	return { ok: true }
})

export const clearShedLog = live(async (ctx) => {
	const snapshot = shedLog.slice()
	shedLog.length = 0
	for (const e of snapshot) {
		ctx.publish(TOPICS.demoPressureShed, 'deleted', e)
	}
	return { cleared: snapshot.length }
})
