// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/flags - live feature flags via live.flag.
 *
 * Two server-controlled flags, each a thin wrapper over a
 * merge-'set' stream:
 *
 *  - banner: a promo banner with { enabled, text }.
 *  - dark-launch: a gradual rollout with { enabled, rolloutPct }.
 *
 * `.set(value)` publishes through the framework-owned platform, so a
 * flip reaches every connected client instantly and relays across the
 * cluster over the wired bus. Flags are cluster-consistent by
 * default: a single-entry shared replay buffer means a client that
 * connects fresh to ANY replica - including one that never set the
 * flag locally - is served the cluster-latest value on connect.
 *
 * The setFlag RPC validates the flag name against an allowlist and
 * the value against a per-flag schema before calling `.set`. Everyone
 * may flip the flags because this is a demo; a real app gates the
 * operator surface behind admin auth (e.g. `if (!ctx.user.isAdmin)
 * throw new LiveError('FORBIDDEN', ...)`).
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

const BANNER_DEFAULT = { enabled: false, text: 'Welcome to the winter sale' }
const DARK_LAUNCH_DEFAULT = { enabled: false, rolloutPct: 0 }

export const banner = live.flag(TOPICS.demoFlagsBanner, BANNER_DEFAULT)
export const darkLaunch = live.flag(TOPICS.demoFlagsDarkLaunch, DARK_LAUNCH_DEFAULT)

/**
 * Per-flag value schemas. Each validator either returns the
 * normalized value or throws LiveError('VALIDATION', ...). Keyed by
 * the wire-facing flag name; doubles as the allowlist.
 */
const FLAGS = {
	banner: {
		flag: banner,
		validate(value) {
			if (!value || typeof value !== 'object') {
				throw new LiveError('VALIDATION', 'banner value must be an object')
			}
			if (typeof value.enabled !== 'boolean') {
				throw new LiveError('VALIDATION', 'banner.enabled must be a boolean')
			}
			const text = String(value.text ?? '').trim().slice(0, 120)
			if (!text) throw new LiveError('VALIDATION', 'banner.text required')
			return { enabled: value.enabled, text }
		}
	},
	'dark-launch': {
		flag: darkLaunch,
		validate(value) {
			if (!value || typeof value !== 'object') {
				throw new LiveError('VALIDATION', 'dark-launch value must be an object')
			}
			if (typeof value.enabled !== 'boolean') {
				throw new LiveError('VALIDATION', 'dark-launch.enabled must be a boolean')
			}
			const pct = Number(value.rolloutPct)
			if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
				throw new LiveError('VALIDATION', 'dark-launch.rolloutPct must be an integer 0-100')
			}
			return { enabled: value.enabled, rolloutPct: pct }
		}
	}
}

/**
 * Flip a flag. Name is checked against the allowlist, the value
 * against that flag's schema, then `.set(value)` pushes the new value
 * to every subscriber on every replica. Demo-open: a real app would
 * gate this behind admin auth.
 */
export const setFlag = live(async (ctx, name, value) => {
	const entry = FLAGS[name]
	if (!entry) throw new LiveError('VALIDATION', `Unknown flag: ${String(name).slice(0, 40)}`)
	const clean = entry.validate(value)
	entry.flag.set(clean)
	return { name, value: clean }
})

/**
 * Reset every flag to its declared default. Purge-style surface for
 * the demo-content purge orchestrator; also exported directly so
 * other server code can restore the demo's baseline.
 */
export async function resetFlags() {
	banner.set(BANNER_DEFAULT)
	darkLaunch.set(DARK_LAUNCH_DEFAULT)
	return { flags: Object.keys(FLAGS).length }
}

/**
 * Purge hook: same signature as the other demos' purge exports. Flags
 * hold no user-typed content beyond the banner text, so purging is
 * just a reset to defaults; the ctx is unused because `.set` publishes
 * through the framework-owned platform.
 */
export async function purge() {
	return resetFlags()
}
