// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/ops - the introspection dashboard.
 *
 * The pitch: one `introspect()` call returns a structured snapshot of the
 * server's entire live dispatch state - connection count, in-flight
 * handlers, topic load, handler counts by kind, push registry sizes,
 * cron/reactive counters, and the transport layer's admission posture.
 * The page polls the `snapshot` RPC on a 3s client interval (only while
 * the tab is visible) and renders it as an ops dashboard.
 *
 * Why this is safe to expose to any visitor: `introspect()` is
 * counts-only and PII-free BY DESIGN - it returns registry sizes and
 * code-structure counts, never user identifiers, presence rosters,
 * handler paths, or topic names. The two opt-ins that would add
 * structural detail (`{ handlers: true }` adds registered handler paths,
 * `{ topics: true }` adds the top-20 topic names, which can embed ids)
 * are deliberately NOT passed here; that detail belongs behind the
 * auth-gated admin route, not on a public demo page.
 *
 * The same snapshot (plus the DLQ and lifeline metrics) is served over
 * HTTP at the fail-closed admin plane the adapter auto-mounts at
 * `/__realtime/*` - `realtime({ admin })` in src/hooks.ws.js only admits
 * requests carrying `Authorization: Bearer ADMIN_TOKEN`. The page's
 * closing card documents that surface; this module is the
 * no-token-required, counts-only sibling.
 *
 * RPCs:
 * - `snapshot()` - `introspect()` verbatim (counts-only defaults).
 * - `dlqSummary()` - the outbound-webhook dead-letter queue's
 *   counts-only summary (`{ total, byTopic, oldest, newest }`), or null
 *   when no DLQ is configured. The store is the Redis-backed
 *   cluster-shared one wired via `configureWebhooks({ deadLetter })` in
 *   src/hooks.ws.js; inspection and replay of the retained records live
 *   on /demos/outbound-webhooks.
 *
 * No cron here on purpose: a 2s server-side ticker would add permanent
 * background load for a page that is rarely open. The read is a pure,
 * cheap in-memory registry walk, so client-side polling while visible
 * is the honest shape.
 */

import { live, introspect, getDeadLetter } from 'svelte-realtime/server'
import { leader } from '$lib/server/redis'

/**
 * Counts-only dispatch snapshot. Pure read over in-memory registry
 * sizes - cheap enough to poll. `transport` is composed in by the
 * adapter platform (null before init or on an adapter without
 * `platform.introspect`).
 *
 * `replica` stamps WHICH worker answered. introspect() is per-process by
 * design (registry sizes, connection count, cron-running are all local to
 * one worker), so on the SO_REUSEPORT cluster each reconnect can land on a
 * different replica and the counts swing. Surfacing the answering worker's
 * id - the same `leader.instanceId` the cluster-cron demo shows - turns
 * that swing from "is this broken?" into "you are reading replica X". It
 * is null only before init / during build analysis (fail-closed facade).
 *
 * `pressureAgeMs` ages the transport pressure sample HERE rather than in
 * the browser. `transport.pressure.sampledAt` is this worker's wall clock,
 * and a visitor's clock has no fixed relation to it, so subtracting one
 * from the other on the client reports the skew between two machines as
 * the age of a measurement. Both halves of this subtraction come from the
 * same process, which is what makes the number mean what it says. It is
 * null while the sampler has not folded, which is also when every other
 * field of the snapshot is still a placeholder.
 */
export const snapshot = live(async () => {
	const snap = await introspect()
	const sampledAt = snap?.transport?.pressure?.sampledAt
	const pressureAgeMs = Number.isFinite(sampledAt) ? Date.now() - sampledAt : null
	return { ...snap, replica: leader.instanceId, pressureAgeMs }
})

/**
 * Counts-only DLQ summary. The Redis-backed store's methods are async
 * (unlike the in-memory default), so the read is awaited; `null` means
 * no dead-letter store is configured at all.
 */
export const dlqSummary = live(async () => {
	const store = getDeadLetter()
	if (!store) return null
	return await store.summary()
})
