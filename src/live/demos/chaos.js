// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/chaos - deterministic chaos with seed + drop rate.
 *
 * The pitch: with a (seed, dropRate) pair, the decision sequence is
 * fully reproducible. Run twice with the same seed; get the same
 * green/red drop pattern. This is the property that
 * `realtime`'s `createTestEnv({ chaos: { dropRate, seed } })` test
 * harness gives you in unit tests - captured here as a runtime
 * surface so you can SEE the determinism before relying on it in
 * a test that asserts "this seq fails this way".
 *
 * Important: this surface is a PEDAGOGICAL re-implementation of the
 * idea, NOT the test harness itself. The actual `createTestEnv`
 * harness lives in `svelte-realtime/test`, which is not part of
 * the production runtime. Use this page to internalise the model;
 * use `createTestEnv` in your test files for real chaos tests.
 *
 * Architecture:
 * - Per-user state: { seed, dropRate, tickN, deliveredN, rng }
 *   keyed by `ctx.user.id`. Module-level Map; cleared on
 *   `stopChaos` (explicit) or on WS close via the exported
 *   `onClose(ws)` hook wired from `src/hooks.ws.js`.
 * - One module-level 100ms ticker arms on first subscribe and
 *   iterates every active user. For each, advance the RNG, decide
 *   drop, publish a record on `demos:chaos:tick:{userId}`. The
 *   record carries `dropped: true|false` so the client can render
 *   the full decision log including drops.
 *
 * Why publish drops instead of withholding them: the demo's
 * subject IS the decision sequence. A test harness logs every
 * decision; this page does too. For "actual wire-drop" semantics
 * the realtime test harness is the right tool.
 */

import { live } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

const TICK_MS = 100
const HISTORY_MAX = 60

// Mulberry32 - compact, well-distributed, 32-bit-state seedable PRNG.
function makeRng(seedInput) {
	let s = (Number(seedInput) | 0) >>> 0
	return function rng() {
		s = (s + 0x6D2B79F5) >>> 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** @type {Map<string, { seed: number, dropRate: number, tickN: number, deliveredN: number, rng: () => number }>} */
const states = new Map()

let armed = false

function armTicker(platform) {
	if (armed) return
	armed = true
	setInterval(() => {
		for (const [userId, state] of states) {
			state.tickN++
			const roll = state.rng()
			const dropped = roll < state.dropRate
			if (!dropped) state.deliveredN++
			platform.publish(TOPICS.demoChaosTick(userId), 'created', {
				id: state.tickN,
				tickN: state.tickN,
				deliveredN: state.deliveredN,
				dropped,
				roll: Math.round(roll * 1000) / 1000,
				ts: Date.now()
			})
		}
	}, TICK_MS)
}

/**
 * Per-user tick stream. Single-arity topic-fn (`(ctx) => topic(...)`)
 * is classified as STATIC by the realtime vite plugin so
 * the client stub is a `StreamStore`, not a `(...args) => StreamStore`
 * factory. Topic is computed server-side from the authenticated
 * `ctx.user.id` - secure-by-construction, no client-tamperable arg.
 */
export const chaosTicks = live.stream(
	(ctx) => TOPICS.demoChaosTick(ctx.user.id),
	async (ctx) => {
		armTicker(ctx.platform)
		return []
	},
	{ merge: 'crud', key: 'id', max: HISTORY_MAX }
)

export const startChaos = live(async (ctx, { seed, dropRate }) => {
	const seedNum = Number(seed)
	if (!Number.isFinite(seedNum)) return { ok: false, error: 'Invalid seed' }
	const drop = Math.max(0, Math.min(1, Number(dropRate) || 0))
	// A new run reuses tick ids from 1. Replace the mounted CRUD stream before
	// the first new event so old keyed rows/counters cannot masquerade as the
	// new deterministic sequence in another tab or on another replica.
	ctx.publish(TOPICS.demoChaosTick(ctx.user.id), 'refreshed', [])
	states.set(ctx.user.id, {
		seed: seedNum | 0,
		dropRate: drop,
		tickN: 0,
		deliveredN: 0,
		rng: makeRng(seedNum)
	})
	return { ok: true, seed: seedNum | 0, dropRate: drop }
})

export const stopChaos = live(async (ctx) => {
	states.delete(ctx.user.id)
	return { ok: true }
})

/**
 * WS close hook. Wired from `src/hooks.ws.js` close handler so a user
 * who starts chaos and disconnects without clicking Stop does not leave
 * an orphan entry in `states` that the 100ms ticker iterates forever.
 * Anonymous demo users get a fresh `ctx.user.id` per session, so the
 * orphan accumulates one entry per dropped session under the previous
 * "demo accepts the leak" comment.
 */
export function onClose(ws) {
	const userId = ws?.getUserData?.()?.id
	if (userId) states.delete(userId)
}

export const myChaosState = live(async (ctx) => {
	const s = states.get(ctx.user.id)
	const base = { id: ctx.user?.id ?? null }
	if (!s) return { ...base, running: false }
	return {
		...base,
		running: true,
		seed: s.seed,
		dropRate: s.dropRate,
		tickN: s.tickN,
		deliveredN: s.deliveredN
	}
})
