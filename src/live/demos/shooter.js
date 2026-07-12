// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/shooter - lag-compensated hit detection on a smoothed world.
 *
 * The pitch: by the time a shot reaches the server, every target has moved
 * on. hitTest rewinds each candidate to the instant the shooter rendered
 * it - the client stamps the shot's render-time, the server bounds the
 * rewind with its OWN uplink + interpolation measurement (a client can
 * inflate its latency only by genuinely lagging), capped at maxRewindMs -
 * and resolves the ray against those historical positions. A hit that
 * landed on your screen lands on the server.
 *
 * Architecture:
 * - live.smooth() on demos:shooter:range with the pure shared apply
 *   (shooter.shared.js). Your dot is predicted; targets interpolate.
 * - onTick drives 8 orbiting NPC targets ('npc:target-0'..7): position is
 *   a pure function of the tick's wall stamp, so the orbits are
 *   deterministic and survive an authority handoff unchanged.
 * - interest covers the whole 640x420 range (radius 800). It is declared
 *   because hitTest REQUIRES interest: the shooter's replicated set is
 *   the candidate-security gate - you cannot hit what was never sent to
 *   you - and here "replicated" happens to mean "everything".
 * - hitTest: ray from the shooter's state toward cmd.angle, circle
 *   hitbox, maxRewindMs 400 (demo-friendly; the competitive default is
 *   100). onHit applies {type:'damage'} to the victim and {type:'score'}
 *   to the shooter through the shared apply, then emits a 'hit' event
 *   the page renders as a spark.
 */

import { live } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { apply, spawnFor, hash01, RANGE_W, RANGE_H, HITBOX_R, SHOT_MAX_DIST } from './shooter.shared.js'

const TICK_MS = 50
const TARGET_COUNT = 8

/**
 * Orbit parameters per target - centers spread across the range, linear
 * speed w*r of roughly 14-41 units/sec. Slow enough that a shot delayed
 * by the page's full 400ms latency slider drifts at most ~17 units off
 * the rendered spot - inside the 18-unit hitbox - yet fast enough that
 * an UN-compensated shot at a moving target would systematically trail.
 */
function orbitFor(i) {
	const key = 'npc:target-' + i
	return {
		cx: 90 + hash01(key, 11) * (RANGE_W - 180),
		cy: 70 + hash01(key, 12) * (RANGE_H - 140),
		r: 40 + hash01(key, 13) * 35,
		w: 0.35 + hash01(key, 14) * 0.2,
		phase: hash01(key, 15) * Math.PI * 2
	}
}

const ORBITS = Array.from({ length: TARGET_COUNT }, (_, i) => orbitFor(i))

export const shooter = live.smooth({
	topic: TOPICS.demoShooterRange,
	apply,
	initial: (key) => spawnFor(key),
	tickMs: TICK_MS,
	onTick(world, t) {
		const ts = t / 1000
		for (let i = 0; i < TARGET_COUNT; i++) {
			const key = 'npc:target-' + i
			const o = ORBITS[i]
			const cur = world.ensure(key, { ...spawnFor(key), npc: true })
			const a = o.phase + o.w * ts
			// set() replaces + broadcasts this tick; hp/score ride along
			// from the current state so damage respawns are not overwritten.
			world.set(key, {
				...cur,
				x: Math.round(o.cx + Math.cos(a) * o.r),
				y: Math.round(o.cy + Math.sin(a) * o.r)
			})
		}
		// Orbits never rest - request the next tick unconditionally.
		return true
	},
	interest: {
		radius: 800,
		position: (s) => ({ x: s.x, y: s.y })
	},
	hitTest: {
		shot: {
			type: 'ray',
			origin: (cmd, state) => ({ x: state.x, y: state.y }),
			dir: (cmd) => Number(cmd.angle) || 0,
			maxDist: SHOT_MAX_DIST
		},
		hitbox: { shape: 'circle', radius: HITBOX_R },
		maxRewindMs: 400,
		onHit: (ctx, target, info) => {
			ctx.applyTo(target.key, { type: 'damage' })
			ctx.applyTo(ctx.identity, { type: 'score' })
			ctx.emitEvent('hit', { by: ctx.identity, target: target.key, at: info.point })
			// Hitscan blocks on the first body - no penetration.
			return { stop: true }
		}
	}
})
