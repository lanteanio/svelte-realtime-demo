/**
 * /demos/denials -- subscribe-denied banner with org switcher.
 *
 * Two "orgs" -- Acme and Globex. Each has its own audit-log stream on
 * topic `audit:{orgSlug}`. The user's identity carries `org` (set in
 * the cookie at upgrade); subscribes to the wrong org return FORBIDDEN
 * via the wire-level subscribe gate in src/hooks.ws.js (which now
 * properly fires on stream subscribes too, after adapter-uws@0.5.0-next.14).
 *
 * Switching orgs goes through the SvelteKit endpoint at
 * src/routes/api/demos/set-org/+server.js, which rewrites the cookie
 * and the page reloads so the next WS handshake picks up the new org.
 *
 * Storage: in-memory per-org log seeded at module load. The "Append"
 * RPC is gated by the same access predicate as the subscribe so a
 * Globex employee can't append to the Acme log.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

const MAX_ENTRIES = 200

const auditLogs = new Map([
	['acme', seedLog('acme', ['Onboarded user', 'Updated billing', 'Reviewed Q3 forecast', 'Approved expense'])],
	['globex', seedLog('globex', ['Cogs sprocket recalibrated', 'Inventory audit', 'Quarterly fire drill'])]
])

function seedLog(orgSlug, actions) {
	const now = Date.now()
	return actions.map((action, i) => ({
		id: crypto.randomUUID(),
		ts: now - (actions.length - i) * 60_000,
		actor: `${orgSlug}-bot`,
		action
	}))
}

function getLog(orgSlug) {
	return auditLogs.get(orgSlug) ?? []
}

function pushEntry(orgSlug, entry) {
	const list = auditLogs.get(orgSlug) ?? []
	list.push(entry)
	if (list.length > MAX_ENTRIES) list.shift()
	auditLogs.set(orgSlug, list)
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
	pushEntry(orgSlug, entry)
	ctx.publish(TOPICS.demoAuditLog(orgSlug), 'created', entry)
	return entry
})
