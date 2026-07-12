// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/forget - right to erasure (live.forget).
 *
 * The pitch: leave traces across the framework's surfaces plus an
 * app-owned Redis log, then press "Forget me". One call purges the
 * framework's per-user state cluster-wide - push registry + sessions,
 * presence rosters, rate-limit buckets, idempotency cached results,
 * webhook dead-letter entries, aggregate k-anonymity cohorts - and the
 * promise resolves only after the durable store's purgeUser confirms
 * (a store failure rejects with FORGET_STORE_FAILED so an incomplete
 * erasure can be retried). The returned constant-shape result carries
 * per-surface removal counts the page renders as the erasure audit.
 *
 * App-owned storage is the app's half of the erasure: live.forget
 * cannot know about this demo's Redis list, so forgetMe deletes it
 * explicitly before running the framework cascade. Any real app has
 * the same split - the framework purges what the framework stored, the
 * app purges its own rows.
 *
 * Security notes:
 *  - forgetMe erases the CALLER (ctx.user.id, never a wire-supplied
 *    id). live.forget is a server action that performs no authz of its
 *    own; a real app would additionally gate an admin path with its
 *    own "may this user be erased" check before passing a foreign id.
 *  - The onForget audit hook receives a HASHED userId, so the audit
 *    log stays PII-free.
 *  - The result is constant-shape (ok is always true on completion);
 *    if it were re-exposed to untrusted callers, a 0-vs-N rowsAffected
 *    must be mapped away or it becomes a user-existence oracle. Here
 *    the caller only ever learns about their own account, so the
 *    counts are safe to show.
 *
 * The composed durable forget store (registry / presence / cursor /
 * rate-limit / replay / idempotency / dead-letter) is wired app-wide
 * via configureForget in src/hooks.ws.js.
 *
 * The app-owned trace log carries a TTL so abandoned demo data
 * self-expires even if nobody presses the button.
 */

import { live } from 'svelte-realtime/server'
import { redis } from '$lib/server/redis'

const LOG_TTL_SECONDS = 3600
const logKey = (userId) => `demos:forget:log:${userId}`

/**
 * Idempotency trace: a cached RPC result keyed by the calling user
 * (server-derived key - no client envelope needed). The cached entry
 * lives in the idempotency cache until ttl and is exactly the kind of
 * per-user row live.forget purges via its per-user reverse index.
 */
export const saveDraft = live.idempotent(
	{ keyFrom: (ctx) => `demos:forget:draft:${ctx.user.id}`, ttl: 300 },
	async (ctx) => ({ savedAt: Date.now(), by: ctx.user.id })
)

/**
 * Write a small burst of app-owned traces: three entries in a Redis
 * list keyed by the calling user. Together with the surfaces the app
 * already populates for every visitor (global presence from the WS
 * hooks, the push registration from the layout) and the saveDraft
 * idempotency entry the page triggers alongside, this is the "data
 * about you" that Forget me erases.
 */
export const leaveTraces = live(async (ctx) => {
	const key = logKey(ctx.user.id)
	const now = Date.now()
	const entries = ['visited the gallery', 'opened a board', 'submitted a form'].map((action, i) => ({
		id: crypto.randomUUID(),
		action,
		ts: now + i
	}))
	const pipeline = redis.redis.multi()
	for (const e of entries) pipeline.rpush(key, JSON.stringify(e))
	pipeline.expire(key, LOG_TTL_SECONDS)
	await pipeline.exec()
	const total = await redis.redis.llen(key)
	return { ok: true, added: entries.length, total }
})

/**
 * App-side audit: what can the app itself count? Only its own storage
 * (the demo log list). Framework-internal surfaces are deliberately
 * not enumerable from app code - the authoritative audit is the
 * surfaces map returned by live.forget itself.
 */
export const auditTraces = live(async (ctx) => {
	const appLog = await redis.redis.llen(logKey(ctx.user.id))
	return { appLog }
})

/**
 * Erase the calling user. App-owned half first (the demo log), then
 * the framework cascade. live.forget resolves only after the durable
 * store confirms; a durable failure rejects, leaving the erasure
 * retryable. The returned surfaces map gets the app-owned count merged
 * in under 'appDemoLog' so the page's audit table shows both halves.
 */
export const forgetMe = live(async (ctx) => {
	const key = logKey(ctx.user.id)
	const appDemoLog = await redis.redis.llen(key)
	await redis.redis.del(key)
	const res = await live.forget(ctx.user.id, {
		tenantId: ctx.tenantId ?? null,
		onForget: ({ userIdHash, rowsAffected }) => {
			// PII-free by contract: the hook receives a hashed id.
			console.log('[demos:forget] erasure', { userIdHash, rowsAffected })
		}
	})
	return {
		ok: res.ok,
		at: res.at,
		rowsAffected: res.rowsAffected + appDemoLog,
		surfaces: { appDemoLog, ...res.surfaces }
	}
})
