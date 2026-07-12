/**
 * /demos/shooter - the pure simulation module shared by server and client.
 *
 * Same contract as arena.shared.js: one pure `apply` imported by both the
 * server declaration (shooter.js) and the page (via a relative import).
 * Two of the commands here are server-authored - hitTest's onHit applies
 * {type:'damage'} to the victim and {type:'score'} to the shooter - and
 * both flow through this same function. A respawn spot therefore draws
 * from ctx.rng (reseeded per command id, identical on the server and any
 * replay), never from Math.random.
 */

export const RANGE_W = 640
export const RANGE_H = 420

// Largest per-command move in range units (~30Hz command cadence).
export const MAX_STEP = 16

// Target hitbox radius - shared so the page renders targets at the exact
// size the server's narrowphase tests against.
export const HITBOX_R = 18

// Maximum shot ray length. Covers most of the range's ~765-unit diagonal.
export const SHOT_MAX_DIST = 700

const SPAWN_MARGIN = 40

function clamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v
}

/**
 * Deterministic [0, 1) from a string key + integer salt (FNV-1a fold with
 * a final avalanche). Stands in for Math.random anywhere a value must be
 * identical on both sides of the wire.
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

/** Deterministic spawn inside the range for any entity key. */
export function spawnFor(key) {
	return {
		x: Math.round(SPAWN_MARGIN + hash01(key, 1) * (RANGE_W - 2 * SPAWN_MARGIN)),
		y: Math.round(SPAWN_MARGIN + hash01(key, 2) * (RANGE_H - 2 * SPAWN_MARGIN)),
		hp: 3,
		score: 0
	}
}

/**
 * The shared simulation step.
 * - {type:'move'}   client-issued, predicted: clamped step inside bounds.
 * - {type:'damage'} server-issued from onHit: hp - 1; at zero, respawn at
 *                   a ctx.rng-drawn spot with full hp (score survives).
 * - {type:'score'}  server-issued from onHit: credit the shooter.
 */
export function apply(state, command, ctx) {
	if (!command) return state
	if (command.type === 'move') {
		const dx = clamp(Number(command.dx) || 0, -MAX_STEP, MAX_STEP)
		const dy = clamp(Number(command.dy) || 0, -MAX_STEP, MAX_STEP)
		if (dx === 0 && dy === 0) return state
		return {
			...state,
			x: clamp(state.x + dx, 0, RANGE_W),
			y: clamp(state.y + dy, 0, RANGE_H)
		}
	}
	if (command.type === 'damage') {
		const hp = state.hp - 1
		if (hp > 0) return { ...state, hp }
		return {
			...state,
			x: Math.round(SPAWN_MARGIN + ctx.rng.float() * (RANGE_W - 2 * SPAWN_MARGIN)),
			y: Math.round(SPAWN_MARGIN + ctx.rng.float() * (RANGE_H - 2 * SPAWN_MARGIN)),
			hp: 3
		}
	}
	if (command.type === 'score') {
		return { ...state, score: (state.score || 0) + 1 }
	}
	return state
}
