/**
 * /demos/arena - the pure simulation module shared by server and client.
 *
 * live.smooth's contract: one pure `apply(state, command)` imported by BOTH
 * the server declaration (arena.js) and the page component (via a relative
 * import - this file is a plain module, not a live module). The client
 * predicts its own entity through this function on the same frame the input
 * happens; the server applies the identical function on its authoritative
 * tick. Purity is what makes prediction and authority provably agree, so
 * this module has no framework imports and no ambient state.
 *
 * Randomness note: nothing here calls Math.random(). Spawn points and NPC
 * velocities derive from a hash of the entity key, so every replica, every
 * replay, and the client prediction all compute the same values.
 */

export const WORLD_W = 2400
export const WORLD_H = 1600

// Largest per-command move in world units. The page sends commands at
// ~30Hz, so this caps legitimate speed while turning a hostile client's
// teleport command into a clamp instead of a jump.
export const MAX_STEP = 24

const SPAWN_MARGIN = 80

function clamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v
}

/**
 * Deterministic [0, 1) from a string key + integer salt (FNV-1a fold with a
 * final avalanche so adjacent keys do not cluster). The demo's stand-in for
 * Math.random anywhere a value must be identical on both sides of the wire.
 */
export function hash01(key, salt) {
	let h = (0x811c9dc5 ^ salt) >>> 0
	const s = String(key)
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 0x01000193)
	}
	h ^= h >>> 15
	h = Math.imul(h, 0x2c1b3c6d)
	h ^= h >>> 12
	return (h >>> 0) / 4294967296
}

/** Deterministic spawn inside the world bounds for any entity key. */
export function spawnFor(key) {
	return {
		x: Math.round(SPAWN_MARGIN + hash01(key, 1) * (WORLD_W - 2 * SPAWN_MARGIN)),
		y: Math.round(SPAWN_MARGIN + hash01(key, 2) * (WORLD_H - 2 * SPAWN_MARGIN))
	}
}

/**
 * The shared simulation step. Only {type:'move'} exists in this world; any
 * other command returns the same reference, which the authority reads as
 * "nothing changed, nothing to broadcast".
 */
export function apply(state, command) {
	if (!command || command.type !== 'move') return state
	const dx = clamp(Number(command.dx) || 0, -MAX_STEP, MAX_STEP)
	const dy = clamp(Number(command.dy) || 0, -MAX_STEP, MAX_STEP)
	if (dx === 0 && dy === 0) return state
	return {
		...state,
		x: clamp(state.x + dx, 0, WORLD_W),
		y: clamp(state.y + dy, 0, WORLD_H)
	}
}

/**
 * Server-side drift for NPC entities (states carrying the npc flag +
 * vx/vy): advance one tick and reflect off the world walls. Player states
 * pass through unchanged, so an idle player rests instead of wandering.
 * Wired as the topic's onMissing hook in arena.js.
 */
export function drift(state) {
	if (!state || !state.npc) return state
	let x = state.x + state.vx
	let y = state.y + state.vy
	let vx = state.vx
	let vy = state.vy
	if (x < 0) { x = -x; vx = -vx }
	else if (x > WORLD_W) { x = 2 * WORLD_W - x; vx = -vx }
	if (y < 0) { y = -y; vy = -vy }
	else if (y > WORLD_H) { y = 2 * WORLD_H - y; vy = -vy }
	return { ...state, x, y, vx, vy }
}
