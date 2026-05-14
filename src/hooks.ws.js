/**
 * WebSocket lifecycle hooks.
 *
 * These functions run on the server whenever a WebSocket connection
 * is established, receives a message, subscribes to a topic, or closes.
 * Think of them as middleware for your WebSocket layer.
 *
 * The adapter calls them automatically - you just export the right names.
 */

import { createMessage, LiveError, setCronPlatform, live, pushHooks, configureCron, _activateDerived } from 'svelte-realtime/server'
import { wirePublishRateMetrics, connectionMetricsHook } from 'svelte-adapter-uws-extensions/prometheus'
import { bus, limiter, presence, cursor, replay, registry, leader } from '$lib/server/redis'
import { metrics } from '$lib/server/metrics'
import { tasks } from '$lib/server/tasks'
import { generateIdentity } from '$lib/names'
// Side-effect import: eagerly loads every demo with a purge surface and
// registers the orchestrator cron at boot. See src/lib/server/demo-purge.js.
import '$lib/server/demo-purge'

/**
 * Message-tier admission control. Pairs with the handshake-tier
 * upgradeAdmission in svelte.config.js.
 *
 * background: cursor moves and note drag shed under any pressure
 * signal (memory, publish-rate, subscriber-ratio). Optional UX,
 * sacrificed first to keep critical paths responsive.
 *
 * critical: note CRUD, board CRUD, settings, arrangement actions only
 * shed under MEMORY pressure. Publish-rate spikes (cursor storms) do
 * not stop a user from saving an edit.
 *
 * Handlers opt in via `if (ctx.shed('background')) throw new
 * LiveError('OVERLOADED', '...')`. Handlers without a shed check run
 * unguarded, which is the right default for non-degradable operations.
 */
live.admission({
	classes: {
		background: ['MEMORY', 'PUBLISH_RATE', 'SUBSCRIBERS'],
		critical: ['MEMORY']
	}
})

/**
 * Configure server-initiated push (`live.push({ userId }, ...)`).
 *
 * - identify: maps a WebSocket to its userId so realtime's local push
 *   registry (populated by pushHooks.open/close below) can route
 *   same-instance pushes via platform.request without any Redis hop.
 * - remoteRegistry: when the userId isn't on this instance, fall through
 *   to `registry.request(userId, ...)` - the extensions cluster
 *   transport. Single-instance dev sees no behavior change because the
 *   local registry hit short-circuits first.
 *
 * Showcased in /demos/notifications. The cluster path is hard to demo
 * locally (one instance) but the wiring is identical to production.
 */
live.configurePush({
	identify: (ws) => ws.getUserData()?.id,
	remoteRegistry: registry
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

const VALID_ORGS = new Set(['acme', 'globex'])

/**
 * Validate an identity object from the cookie. Returns null if invalid.
 * We check every field strictly - never trust client-provided data.
 *
 * `org` is optional. When set, must be one of the demo's two
 * organizations (`acme` or `globex`); used by /demos/denials to gate
 * access to org-scoped audit-log streams. Unset is treated as "no org"
 * and denies every audit:* subscribe.
 */
function validateIdentity(obj) {
	if (!obj || typeof obj !== 'object') return null
	if (typeof obj.id !== 'string' || !UUID_RE.test(obj.id)) return null
	if (typeof obj.name !== 'string' || obj.name.length < 1 || obj.name.length > 40) return null
	if (typeof obj.color !== 'string' || !HEX_COLOR_RE.test(obj.color)) return null
	const org = VALID_ORGS.has(obj.org) ? obj.org : null
	return { id: obj.id, name: obj.name, color: obj.color, org }
}

/**
 * Called when a client wants to upgrade from HTTP to WebSocket.
 * Whatever this function returns becomes `ws.getUserData()` for the
 * lifetime of that connection. Here we use it to attach the user's identity.
 *
 * If the client has a valid identity cookie, we reuse it.
 * Otherwise, we generate a fresh random identity (no login required).
 */
export function upgrade({ cookies }) {
	const existing = cookies.identity
	if (existing) {
		try {
			const parsed = validateIdentity(JSON.parse(existing))
			if (parsed) return parsed
		} catch {}
	}

	const identity = {
		id: crypto.randomUUID(),
		// Default new visitors to Acme. /demos/denials lets them switch
		// to Globex via the org-set endpoint, which rewrites the cookie
		// and reloads so the next WS handshake picks up the new org.
		org: 'acme',
		...generateIdentity()
	}

	// Set the cookie so the identity persists across page refreshes
	cookies.identity = JSON.stringify(identity)
	return identity
}

/**
 * Boot-time one-shot setup.
 *
 * Fires once per worker after the listen socket is bound and BEFORE
 * any upgrade / open / message hook can run. The deterministic place
 * to capture a `platform` reference for any code that needs it at
 * boot rather than on first connect.
 *
 * What lives here:
 * - `bus.activate(platform)` - the Redis pub/sub subscriber needs the
 *   platform to fan inbound cluster messages out to local subscribers.
 * - `setCronPlatform(platform)` - realtime's cron tick captures a
 *   platform reference; without this, the 1Hz tick from the
 *   notifications scheduler fires no-op until first connect.
 * - `wirePublishRateMetrics(...)` - one-shot gauge registration
 *   against the worker-local `platform.pressure` snapshot.
 * - `live.configureCron({ leader })` - gates the cron tick on the
 *   Redis-backed leader-election primitive so cron schedules fire
 *   ONCE across the cluster instead of N times across N workers.
 *   Single-instance dev: this worker is always the leader.
 *
 * Per-worker in cluster mode (CLUSTER_MODE=reuseport on Linux,
 * acceptor on macOS/Windows). N workers = N init calls; that's why
 * the leader-election layer matters for cron singleton semantics.
 *
 * Async-allowed; throwing here rejects boot and crashes the worker
 * (loud failure surfaces as an unhandled rejection). All the work
 * here is sync today, but `init` is awaited by the adapter so this
 * shape is forward-compatible.
 */
export function init({ platform }) {
	// Stash the replay extension on the source platform so realtime's
	// auto-replay routing (svelte-realtime next.21) can find the buffer
	// on every wrapped seam. `bus.wrap()` (extensions next.15) forwards
	// `.replay` via a live getter, so any per-tick / per-message
	// re-wrap also sees it.
	platform.replay = replay
	bus.activate(platform)
	setCronPlatform(platform)

	// Tune the dev-mode warnings to match the demo gallery's
	// intentional shapes. `/demos/pressure` purposefully bursts at
	// ~3.3K events/sec for 1.5s to drive PUBLISH_RATE shedding;
	// raise the publish-rate warning threshold above that so the
	// rate warning only surfaces on genuinely surprising bursts.
	// Suppress silent-topic warnings on the two demo topics that
	// are subscribed continuously but only publish on user action
	// (`boards`) or via a self-arming ticker that may briefly idle
	// (`demos:pressure:tick`).
	live.publishRateWarning({ threshold: 10000 })
	live.silentTopicWarning({ suppress: ['boards', 'demos:pressure:tick'] })
	// _activateDerived wraps platform.publish + publishBatched so
	// live.derived / live.aggregate / live.effect watchers fire on
	// source-topic publishes. Per realtime's recommended
	// wire-up site, this lives in init({ platform }) - and per
	// the late-activation fix it now installs the wrap for
	// static aggregates / effects / derived too, not just dynamic-
	// derived. Cron-driven publishes that fire before the first WS
	// connection (e.g. /demos/topk's firehose) reach the aggregate
	// watcher correctly.
	_activateDerived(platform)
	wirePublishRateMetrics(platform, metrics, { topN: 20 })
	// `bus` gives cron ticks cluster-wide fan-out. The cron tick wraps
	// _cronPlatform with bus.wrap on each fire; bus.wrap forwards
	// `.replay` (since extensions next.15) so the framework's
	// auto-replay routing finds the buffer on the wrapped seam too.
	configureCron({ leader: () => leader.isLeader(), bus })
}

/**
 * Teardown one-shot.
 *
 * Fires once per worker before the listen socket closes and before
 * existing connections are kicked. Best-effort: throws are logged
 * and swallowed by the adapter, so cleanup is safe to attempt.
 *
 * - `leader.stop()` - best-effort releases the Redis lease via
 *   compare-and-delete so a sibling worker can take over within
 *   `renewMs` (10s) instead of waiting for the full `leaseMs` (30s).
 * - `registry.destroy()` - stops the connection registry's
 *   heartbeat timer and Redis subscriber so the worker can exit
 *   cleanly.
 */
export async function shutdown() {
	// `tasks` is null when DATABASE_URL is empty; destroy() drops the
	// dispatch / recovery / cleanup timers so the worker exits promptly.
	tasks?.destroy()
	await Promise.allSettled([
		leader.stop(),
		registry.destroy()
	])
}

/**
 * Called once when the WebSocket connection is fully open.
 * Per-connection setup only - one-shot worker setup lives in `init`
 * above.
 */
export function open(ws, ctx) {
	const { platform } = ctx
	// Put the connection into the pub/sub bus's `systemChannel`
	// subscriber set via `platform.subscribe` (which bypasses the
	// wire-level `__`-deny gate). Without this, the bus publishes
	// degraded / recovered events into an empty set and the layout's
	// `{#if $health === 'degraded'}` banner is silently dead. Required
	// as of `svelte-adapter-uws-extensions@0.5.0-next.13`.
	bus.hooks.open(ws, ctx)
	presence.join(ws, 'global', platform)
	// Register the connection in realtime's local push registry (so
	// live.push routes via platform.request) and in the cluster registry
	// (so cross-instance pushes find this user via Redis).
	pushHooks.open(ws, ctx)
	registry.hooks.open(ws, ctx)
}

/**
 * Topic denial gate. Returns a denial reason string, or null if allowed.
 *
 * Two surfaces use it today:
 *
 * - /demos/chat: one members-only room (`private`) is denied
 *   unconditionally. Banner appears via the per-stream `error`
 *   Readable.
 * - /demos/denials: org-scoped `audit:{orgSlug}` streams. The user's
 *   identity (set in upgrade) carries `org`; subscribes to a different
 *   org return FORBIDDEN. Surfaces both on the per-stream error AND on
 *   the adapter's top-level `denials` Readable, which the page renders
 *   as a recent-denials list.
 *
 * The gate is sync (the wire-level subscribe-batch hook is sync); both
 * checks are pure topic + ws.userData lookups, no I/O.
 */
const PRIVATE_CHAT_RE = /^demos:chat:private(:presence)?$/
const AUDIT_TOPIC_RE = /^audit:(acme|globex)$/

function denialFor(topic, ws) {
	if (PRIVATE_CHAT_RE.test(topic)) return 'FORBIDDEN'
	const auditMatch = AUDIT_TOPIC_RE.exec(topic)
	if (auditMatch) {
		const userOrg = ws?.getUserData()?.org
		if (userOrg !== auditMatch[1]) return 'FORBIDDEN'
	}
	return null
}

/**
 * Called when a client subscribes to a live stream topic.
 * We delegate to the presence and cursor plugins so they can track
 * who's watching what and send cursor snapshots to new joiners.
 *
 * Fires for solo subscribes only. Multi-topic subscribes (initial mount,
 * reconnect resume) land in `subscribeBatch` below as one wire frame.
 *
 * Returning a string denies the subscribe with that reason; return
 * undefined to allow.
 */
export function subscribe(ws, topic, ctx) {
	const reason = denialFor(topic, ws)
	if (reason) return reason
	presence.hooks.subscribe(ws, topic, ctx)
	cursor.hooks.subscribe(ws, topic, ctx)
}

/**
 * Called once per subscribe-batch wire frame. Microtask-batched initial
 * mounts coalesce N subscribes into one frame, so a board page that
 * subscribes to notes / settings / activity / presence / cursor topics
 * triggers this hook once instead of the per-topic `subscribe` hook
 * five times.
 *
 * Returning a record of `{ topic: reason }` denies those topics with a
 * structured reason the client renders via the `denials` store. Returning
 * undefined or {} allows everything.
 *
 * Sync only. For async grants, pre-cache them on userData during upgrade.
 */
export function subscribeBatch(ws, topics, ctx) {
	let denials
	for (const topic of topics) {
		const reason = denialFor(topic, ws)
		if (reason) {
			(denials ??= {})[topic] = reason
			continue
		}
		presence.hooks.subscribe(ws, topic, ctx)
		cursor.hooks.subscribe(ws, topic, ctx)
	}
	return denials
}

/**
 * Called when a client's topic reference count reaches zero.
 * This fires in real time (the moment the client drops a topic),
 * not only at socket close. We clean up presence and cursor state
 * for just that topic so departed users disappear immediately.
 */
export function unsubscribe(ws, topic, ctx) {
	presence.hooks.unsubscribe(ws, topic, ctx)
}

/**
 * Called when the WebSocket closes (tab closed, network drop, etc).
 * Clean up: remove from all remaining presence channels and delete
 * cursor state. The unsubscribe hook already handled any topics the
 * client explicitly dropped before disconnect, so close only handles
 * whatever is still active.
 *
 * Wrapped in connectionMetricsHook so per-connection histograms
 * (duration, messages, bytes) and the close-code counter emit on every
 * close. The user-supplied close runs first; metrics observation runs
 * after, so a throw in the user close still misses metrics for that
 * connection (acceptable - a thrown close is an exceptional path).
 */
export const close = connectionMetricsHook(metrics, (ws, ctx) => {
	presence.hooks.close(ws, ctx)
	cursor.hooks.close(ws, ctx)
	// Pass ctx so pushHooks.close routes through the realtime close
	// that drains stream-subscription bookkeeping (silent-topic
	// watchdogs, _topicWsCounts, __onUnsubscribe callbacks). Without
	// the second arg, the compatibility branch keeps it
	// push-only and the silent-topic watchdog never disarms when test
	// pages close, producing 30s-delayed warning floods.
	pushHooks.close(ws, ctx)
	registry.hooks.close(ws, ctx)
})

/**
 * RPCs that should bypass rate limiting. These fire very frequently
 * during normal use (every mouse move, every drag frame) and would
 * instantly exhaust the rate limit budget if counted.
 */
const THROTTLED_RPCS = new Set(['boards/notes/moveNote', 'boards/cursors/moveCursor', 'boards/cursors/joinBoard'])

/**
 * The message handler processes all incoming RPC calls from clients.
 * Before each RPC executes, we check the rate limit (unless it's a
 * throttled RPC like cursor movement).
 *
 * Rate limit: 100 requests per 10 seconds per user. If exceeded, the
 * client gets a RATE_LIMITED error with a countdown.
 */
export const message = createMessage({
	// bus.wrap fans out to Redis for cluster delivery and (since
	// extensions next.15) forwards platform.replay so realtime's
	// auto-replay routing reaches the buffer.
	platform: (p) => bus.wrap(p),
	async beforeExecute(ws, rpcPath) {
		if (THROTTLED_RPCS.has(rpcPath)) return
		const { allowed, resetMs } = await limiter.consume(ws)
		if (!allowed) throw new LiveError('RATE_LIMITED', `Retry in ${Math.ceil(resetMs / 1000)}s`)
	}
})

/**
 * Adapter session-resume hook. Fires on WebSocket reconnect when the
 * client presents its previous sessionId + per-topic lastSeenSeqs.
 * The replay extension's resumeHook iterates the topics and gap-fills
 * each via the existing __replay:{topic} pipeline. Without this hook,
 * reconnects fall through to live mode and the client refetches via
 * initial subscribe (visible flicker on a busy board).
 */
export const resume = replay.resumeHook()
