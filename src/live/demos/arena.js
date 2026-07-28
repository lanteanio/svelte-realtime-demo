// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/arena - area-of-interest culling on a smoothed-entity world.
 *
 * The pitch: a 2400x1600 arena with ~150 server-driven NPCs plus every
 * visitor's own dot, but each client only receives the entities inside a
 * 420-unit radius around its own position. The HUD's live ratio
 * ("receiving X of Y") is the whole story: fan-out cost scales with what
 * each player can SEE, not with the world's population.
 *
 * Architecture:
 * - live.smooth() on the static topic demos:arena:main. The pure `apply`
 *   lives in arena.shared.js and is imported by this file AND the page,
 *   so client prediction and the server authority run the same step.
 * - onTick ensures the NPC roster ('npc:0'..'npc:149') and returns true
 *   so the tick never idles; onMissing (the shared `drift`) bounces the
 *   NPCs off the walls between ticks. Spawn and velocity both come from
 *   a hash of the NPC key - no Math.random anywhere in the sim.
 * - interest: { radius, position, lod } is the per-client cull: near
 *   entities every tick, the mid ring every 3rd, the fringe every 6th.
 * - `population` is a plain RPC returning the authoritative catalog size
 *   (tracked from onTick) so the HUD shows an honest denominator.
 *
 * Cluster note: platform.smooth (wired in src/hooks.ws.js) makes one
 * replica the topic's tick authority; the others forward commands and
 * relay its updates, and each replica re-culls the relayed frames against
 * its own subscribers - the cull holds on the 4-replica deploy too.
 */

import { live } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { redis } from '$lib/server/redis'
import { apply, drift, spawnFor, hash01 } from './arena.shared.js'

const TICK_MS = 50
const NPC_COUNT = 150
const POPULATION_KEY = 'demos:arena:population'

/**
 * NPC starting state: shared spawn plus a hash-derived velocity of
 * 1.5-3 world units per 50ms tick (30-60 units/sec), so every replica
 * computes the same heading for the same key.
 */
function npcSpawn(key) {
	const angle = hash01(key, 3) * Math.PI * 2
	const speed = 1.5 + hash01(key, 4) * 1.5
	return {
		...spawnFor(key),
		vx: Math.cos(angle) * speed,
		vy: Math.sin(angle) * speed,
		npc: true
	}
}

// Authoritative catalog size, refreshed once per tick on the instance
// that runs the authority. Mirror changes to Redis so `population()` can
// answer from any RPC replica; SO_REUSEPORT does not guarantee that the
// page's RPC lands on the smooth authority process.
let lastCatalogSize = 0
let lastStoredCatalogSize = -1
let cachedPopulation = null
let cachedPopulationAt = 0

// The size only moves when a player joins or leaves, so a write per change is
// enough; `mirrorPopulation` is called from inside a 50ms tick and must never
// throw into it.
function mirrorPopulation(size) {
	if (size === lastStoredCatalogSize) return
	lastStoredCatalogSize = size
	try {
		void redis.redis.set(POPULATION_KEY, String(size)).catch(() => {
			// Retry on the next tick if Redis was transiently unavailable.
			lastStoredCatalogSize = -1
		})
	} catch {
		lastStoredCatalogSize = -1
	}
}

export const arena = live.smooth({
	topic: TOPICS.demoArenaMain,
	apply,
	initial: (key) => spawnFor(key),
	tickMs: TICK_MS,
	broadcastHz: 20,
	onMissing: drift,
	onTick(world) {
		for (let i = 0; i < NPC_COUNT; i++) {
			const key = 'npc:' + i
			if (world.get(key) === undefined) world.ensure(key, npcSpawn(key))
		}
		lastCatalogSize = world.catalog().length
		// The NPCs never rest and the HUD denominator should stay current even
		// while every player idles - request the next tick always. The mirror
		// below is the only statement here that can throw, and onTick's return
		// value decides whether the arena keeps ticking at all, so nothing may
		// sit between it and the return.
		mirrorPopulation(lastCatalogSize)
		return true
	},
	interest: {
		radius: 420,
		position: (s) => ({ x: s.x, y: s.y }),
		lod: [
			{ within: 180, rate: 1 },
			{ within: 300, rate: 3 },
			{ within: 420, rate: 6 }
		]
	}
})

/**
 * Catalog size for the HUD's "receiving X of Y" line. The world object only
 * exists inside the authority tick, so onTick mirrors size changes into Redis
 * and every replica reads the same denominator.
 *
 * The page polls this every 2s per open tab, so the read is cached for one
 * second per process: without it a busy arena turns one HUD line into O(tabs)
 * Redis round trips. A read failure falls back to the local cell rather than
 * rejecting - this RPC could not fail before, and surfacing an infrastructure
 * error in the demo's error line would be a worse answer than a stale count.
 */
export const population = live(async () => {
	const now = Date.now()
	if (cachedPopulation !== null && now - cachedPopulationAt < 1000) return cachedPopulation
	let shared = null
	try {
		const raw = await redis.redis.get(POPULATION_KEY)
		if (raw !== null) {
			const parsed = Number(raw)
			if (Number.isFinite(parsed) && parsed >= 0) shared = parsed
		}
	} catch {
		shared = null
	}
	// Before the first mirrored write this replica may hold 0 while another
	// holds the real size; prefer whichever is actually populated.
	const value = shared ?? lastCatalogSize
	cachedPopulation = value
	cachedPopulationAt = now
	return value
})
