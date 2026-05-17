/**
 * /demos/denials - subscribe-denied banner with org switcher.
 *
 * Two "orgs" - Acme and Globex. Each has its own audit-log stream on
 * topic `audit:{orgSlug}`. The user's identity carries `org` (set in
 * the cookie at upgrade); subscribes to the wrong org return FORBIDDEN
 * via the wire-level subscribe gate in src/hooks.ws.js (which now
 * properly fires on stream subscribes too).
 *
 * Switching orgs goes through the SvelteKit endpoint at
 * src/routes/api/demos/set-org/+server.js, which rewrites the cookie
 * and the page reloads so the next WS handshake picks up the new org.
 *
 * Storage: cluster-shared Redis LIST per org. The page renders the
 * gate behavior (FORBIDDEN banner) as the headline demo; the log
 * contents are secondary. A one-shot SETNX-guarded seed inserts
 * representative entries on first boot across the cluster so the
 * demo isn't empty on a fresh checkout. The "Append" RPC is gated by
 * the same access predicate as the subscribe so a Globex employee
 * can't append to the Acme log.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { redis } from '$lib/server/redis'

const MAX_ENTRIES = 200
const SEEDED_KEY = 'demos:denials:seeded'
const auditKey = (orgSlug) => `demos:denials:audit:${orgSlug}`

const SEED_DATA = {
	acme: ['Onboarded user', 'Updated billing', 'Reviewed Q3 forecast', 'Approved expense'],
	globex: ['Cogs sprocket recalibrated', 'Inventory audit', 'Quarterly fire drill']
}

async function seedIfNeeded() {
	try {
		const ok = await redis.redis.set(SEEDED_KEY, '1', 'NX', 'EX', 3600)
		if (ok !== 'OK') return
		const now = Date.now()
		const pipeline = redis.redis.multi()
		for (const [orgSlug, actions] of Object.entries(SEED_DATA)) {
			pipeline.del(auditKey(orgSlug))
			for (let i = 0; i < actions.length; i++) {
				const entry = {
					id: crypto.randomUUID(),
					ts: now - (actions.length - i) * 60_000,
					actor: `${orgSlug}-bot`,
					action: actions[i]
				}
				pipeline.rpush(auditKey(orgSlug), JSON.stringify(entry))
			}
		}
		await pipeline.exec()
	} catch {
		// Best-effort - a Redis blip during boot defers seeding to the
		// next worker.
	}
}
seedIfNeeded()

async function getLog(orgSlug) {
	const raws = await redis.redis.lrange(auditKey(orgSlug), 0, -1)
	const out = []
	for (const raw of raws) {
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
	}
	return out
}

/**
 * RPUSH appends newest-last; LTRIM bounds the list at MAX_ENTRIES.
 * No 'deleted' publish on overflow eviction here - the audit log is
 * append-only from the user's perspective and the eviction is silent
 * (matches the original Map+shift semantics).
 */
async function pushEntry(orgSlug, entry) {
	const pipeline = redis.redis.multi()
	pipeline.rpush(auditKey(orgSlug), JSON.stringify(entry))
	pipeline.ltrim(auditKey(orgSlug), -MAX_ENTRIES, -1)
	await pipeline.exec()
}

/**
 * Wipe every org's audit log. Seeds are NOT restored so the next purge
 * cycle does not republish them; subsequent fresh visitors see an empty
 * log, which still demonstrates the access gate (the FORBIDDEN banner
 * is what the demo is actually selling).
 */
export async function purge(ctx) {
	const counts = {}
	for (const orgSlug of Object.keys(SEED_DATA)) {
		const raws = await redis.redis.lrange(auditKey(orgSlug), 0, -1)
		await redis.redis.del(auditKey(orgSlug))
		counts[orgSlug] = raws.length
		for (const raw of raws) {
			try {
				const entry = JSON.parse(raw)
				ctx.publish(TOPICS.demoAuditLog(orgSlug), 'deleted', { id: entry.id })
			} catch { /* corrupt entry already gone */ }
		}
	}
	return counts
}

export const auditLog = live.stream(
	(ctx, orgSlug) => TOPICS.demoAuditLog(orgSlug),
	async (ctx, orgSlug) => getLog(orgSlug),
	{ merge: 'crud', key: 'id' }
)

export const myOrg = live(async (ctx) => ({ org: ctx.user?.org ?? null, name: ctx.user?.name ?? null }))

export const appendEntry = live(async (ctx, orgSlug, action) => {
	if (!ctx.user?.org) throw new LiveError('UNAUTHENTICATED', 'No org set')
	if (ctx.user.org !== orgSlug) throw new LiveError('FORBIDDEN', `Not a ${orgSlug} employee`)
	const trimmed = String(action ?? '').trim().slice(0, 200)
	if (!trimmed) throw new LiveError('VALIDATION', 'Action required')
	const entry = {
		id: crypto.randomUUID(),
		ts: Date.now(),
		actor: ctx.user.name,
		action: trimmed
	}
	await pushEntry(orgSlug, entry)
	ctx.publish(TOPICS.demoAuditLog(orgSlug), 'created', entry)
	return entry
})
