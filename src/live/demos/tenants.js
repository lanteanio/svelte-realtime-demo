// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/tenants - strict per-connection tenant isolation.
 *
 * The pitch. One shared scratchpad, declared once, on one literal
 * topic. When the connection carries a tenant (the resolver in
 * src/hooks.ws.js reads the session's optional `tenant` field), the
 * framework scopes EVERYTHING this connection touches server-side:
 * the stream's subscribe topic and every `ctx.publish` land on
 * `@t/<tenantId>/demos:tenants:pad` instead of the literal topic.
 *
 * Say it loudly: the handler code below is byte-identical to a
 * single-tenant app. No handler mentions the tenant for pub/sub -
 * `live.stream('demos:tenants:pad', ...)` and
 * `ctx.publish('demos:tenants:pad', ...)` are written exactly as if
 * tenancy did not exist, and the framework auto-prefixes both at the
 * wire layer. An Acme connection and a Globex connection run the same
 * bytes and can never see each other's notes - not even with
 * hand-rolled wire frames, because raw subscribes to a topic the
 * server never authorized for the connection are denied.
 *
 * The ONE thing that is not auto-scoped is app-owned storage: the
 * framework cannot know how your Redis keys are laid out. So the
 * Redis key is scoped manually with `ctx.tenantId` - that is the
 * whole per-tenant delta in this file.
 *
 * Storage: cluster-shared Redis LIST per tenant scope (newest note at
 * index 0 via LPUSH), bounded at MAX_NOTES. The stream renders
 * newest-first, so it is declared with `prepend: true` and 'created'
 * publishes land at the top.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { redis } from '$lib/server/redis'
import { TOPICS } from '$lib/server/topics'

const MAX_NOTES = 20
const TENANTS = ['acme', 'globex']

/**
 * App-owned storage is NOT auto-scoped - the framework prefixes wire
 * topics, not your database keys. Scope the Redis key by the
 * connection's server-trusted `ctx.tenantId` (never a client-supplied
 * value); unscoped connections share the 'public' variant.
 */
const padKey = (tenantId) => `demos:tenants:pad:${tenantId ?? 'public'}`

async function getNotes(tenantId) {
	const raws = await redis.redis.lrange(padKey(tenantId), 0, MAX_NOTES - 1)
	const out = []
	for (const raw of raws) {
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
	}
	return out
}

/**
 * The shared-per-tenant scratchpad. Note the topic is the plain
 * literal string - under an active tenant the framework subscribes
 * the socket to `@t/<tenantId>/demos:tenants:pad` server-side, so an
 * Acme tab and a Globex tab hold disjoint wire topics while running
 * this exact line. Only the loader's storage read names the tenant,
 * because Redis keys are app-owned (see padKey above).
 */
export const pad = live.stream(
	TOPICS.demoTenantsPad,
	async (ctx) => getNotes(ctx.tenantId),
	{ merge: 'crud', key: 'id', prepend: true }
)

/**
 * Post a note to the pad. The `ctx.publish` targets the literal topic
 * and the framework auto-prefixes it to the connection's tenant scope
 * - a Globex subscriber never receives an Acme 'created', and vice
 * versa. Byte-identical to the single-tenant version of this handler
 * except for the manual Redis key scoping.
 *
 * LTRIM bounds the list silently (no 'deleted' publish on overflow
 * eviction); already-subscribed clients keep their longer list until
 * the next reload, which is fine for a scratchpad.
 */
export const addNote = live(async (ctx, text) => {
	const trimmed = String(text ?? '').trim().slice(0, 200)
	if (!trimmed) throw new LiveError('VALIDATION', 'Note text required')
	const note = {
		id: crypto.randomUUID(),
		ts: Date.now(),
		author: ctx.user?.name ?? 'anonymous',
		text: trimmed
	}
	const key = padKey(ctx.tenantId)
	const pipeline = redis.redis.multi()
	pipeline.lpush(key, JSON.stringify(note))
	pipeline.ltrim(key, 0, MAX_NOTES - 1)
	await pipeline.exec()
	ctx.publish(TOPICS.demoTenantsPad, 'created', note)
	return note
})

/**
 * Who am I, according to the server? Returns the connection's
 * server-trusted tenant id (derived at upgrade by the resolver in
 * src/hooks.ws.js - never read off the wire). The page banner renders
 * this instead of trusting any client-side state.
 */
export const whoami = live(async (ctx) => ({ tenantId: ctx.tenantId ?? null }))

/**
 * Wipe every pad variant (acme / globex / public). Called from the
 * purge orchestrator's cron, which has no per-connection tenant scope:
 * the public variant publishes through the unscoped `ctx.publish`,
 * while the tenant variants go through `live.tenant(id).publish` -
 * the server-side handle for targeting a tenant's scope from outside
 * a request handler.
 */
export async function purge(ctx) {
	const counts = {}
	for (const tenantId of [...TENANTS, null]) {
		const key = padKey(tenantId)
		const raws = await redis.redis.lrange(key, 0, -1)
		await redis.redis.del(key)
		counts[tenantId ?? 'public'] = raws.length
		const scope = tenantId ? live.tenant(tenantId) : null
		for (const raw of raws) {
			try {
				const note = JSON.parse(raw)
				if (scope) scope.publish(TOPICS.demoTenantsPad, 'deleted', { id: note.id })
				else ctx.publish(TOPICS.demoTenantsPad, 'deleted', { id: note.id })
			} catch { /* corrupt entry already gone */ }
		}
	}
	return counts
}
