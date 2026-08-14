/**
 * WebSocket lifecycle hooks.
 *
 * These functions run on the server whenever a WebSocket connection
 * is established, receives a message, subscribes to a topic, or closes.
 * Think of them as middleware for your WebSocket layer.
 *
 * The adapter calls them automatically - you just export the right names.
 */

import v8 from 'node:v8'
import path from 'node:path'
import os from 'node:os'
import { createMessage, LiveError, setCronPlatform, live, pushHooks, unsubscribe as realtimeUnsubscribe, configureCron, _activateDerived, realtime, configureAlarm, configureForget, configureWebhooks } from 'svelte-realtime/server'
import { wirePublishRateMetrics, connectionMetricsHook } from 'svelte-adapter-uws-extensions/prometheus'
import { createForgetStore } from 'svelte-adapter-uws-extensions/forget-store'
import {
	activateRedisInfrastructure,
	destroyRedisCoordinators,
	redisCoordinators,
	bus,
	limiter,
	presence,
	cursor,
	replay,
	registry,
	leader,
	redis
} from '$lib/server/redis'
import { env } from '$env/dynamic/private'
import { metrics } from '$lib/server/metrics'
import { PROTOCOL_VERSION } from '$lib/protocol-version'
import { activateTaskInfrastructure, destroyTaskInfrastructure, idempotencyStore } from '$lib/server/tasks'
import { forgetDraftIdempotency } from '$lib/server/forget-demo'
import { TOPICS } from '$lib/server/topics'
import { startLocalHealthServer, stopLocalHealthServer } from '$lib/server/local-health'
import { lookupSession, createSession, tryParseLegacyJsonCookie } from '$lib/server/identity-session'
import { evaluateUpgradeOrigin, upgradeOriginPolicy } from '$lib/server/origin-policy'
import { isPerFrameRpc } from '$lib/server/rpc-limits'
import { onClose as chaosOnClose } from '$live/demos/chaos'
import { armPressureTicker } from '$live/demos/pressure'
// Side-effect import: eagerly loads every demo with a purge surface at boot.
// The purge crons themselves register via the codegen because the module
// lives under src/live/. See src/live/_purge.js.
import '$live/_purge'

// SIGUSR2 heap-snapshot trigger. `kill -SIGUSR2 <pid>` on the host writes
// a `heap-<timestamp>.heapsnapshot` file under HEAP_SNAPSHOT_DIR (default
// os.tmpdir(); load it in Chrome DevTools -> Memory tab to see top
// retainers. Configurable so containers whose CWD is owned by root can
// point the dump at a writable directory (e.g. /tmp) without sed-patching
// the build at runtime.
const HEAP_SNAPSHOT_DIR = process.env.HEAP_SNAPSHOT_DIR || os.tmpdir()
process.on('SIGUSR2', () => {
	const file = path.join(HEAP_SNAPSHOT_DIR, `heap-${Date.now()}-${process.pid}.heapsnapshot`)
	try {
		v8.writeHeapSnapshot(file)
		console.log(`[heap-dump] wrote ${file} pid=${process.pid} rss=${Math.round(process.memoryUsage.rss() / 1024 / 1024)}MB`)
	} catch (err) {
		console.error(`[heap-dump] failed pid=${process.pid} dir=${HEAP_SNAPSHOT_DIR}`, err)
	}
})

const _asyncWarningAt = new Map()
let stopPressureTicker = () => {}

// Teaching accelerant for the from-seq demo. The fast stream still publishes
// through the real replay extension so a fresh subscription receives a
// protocol sequence cursor. On resume, this one topic deliberately reports a
// bounded-buffer miss; realtime treats a falsy `since()` as a miss and
// continues through its native delta.fromSeq tier. Without it a visitor would
// have to idle past the 200-event buffer to see that tier at all.
// The normal from-seq topic keeps the production replay behavior unchanged.
//
// The comparison is on the topic SUFFIX because a tenant-scoped connection is
// served the rewritten `@t/<tenant>/<topic>` form. A visitor who tours
// /demos/tenants first carries a tenant on the session, and a strict equality
// check would silently stop matching for exactly those visitors - the page
// would promise a buffer miss and quietly get the ordinary replay tier.
const FAST_FROM_SEQ_TOPIC_RE = new RegExp(`(^|/)${TOPICS.demoFromSeqFastEvents.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
const demoReplay = Object.create(replay)
demoReplay.since = (topic, sinceSeq) => {
	if (typeof topic === 'string' && FAST_FROM_SEQ_TOPIC_RE.test(topic) && typeof sinceSeq === 'number') return null
	return replay.since(topic, sinceSeq)
}

function reportAsyncFailure(label, error) {
	const now = Date.now()
	if (now - (_asyncWarningAt.get(label) ?? 0) < 5000) return
	_asyncWarningAt.set(label, now)
	console.warn(`[realtime] ${label} degraded`, {
		name: error?.name,
		code: error?.code
	})
}

/**
 * Run an extension hook from an adapter hook that is synchronous. Hooks that
 * complete synchronously (the cursor/presence message hot path at 125Hz) stay
 * allocation-free; the Promise wrapper and .catch are attached only when a hook
 * actually returns a thenable, so a real async rejection is still observed.
 */
function bestEffort(label, operation) {
	try {
		const result = operation()
		if (result && typeof result.then === 'function') {
			result.catch((error) => reportAsyncFailure(label, error))
		}
	} catch (error) {
		reportAsyncFailure(label, error)
	}
}

async function awaitBestEffort(label, operation) {
	try {
		return await operation()
	} catch (error) {
		reportAsyncFailure(label, error)
	}
}

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
 * Framework-level 0.6 configuration. realtime() is used as the one-call
 * config seam only - its module-level setters install the tenant resolver,
 * protocol-version signal, and admin handler - while the hand-rolled hooks
 * below stay in charge of the actual open/close/message lifecycle (they
 * carry the presence/cursor/registry/denial wiring realtime()'s generic
 * hook set does not know about). bus/leader are deliberately NOT passed
 * here: init() below wires configureCron({ leader, bus }) itself, and a
 * second leader-only call would drop the bus.
 *
 * - tenant: opt-in per-connection isolation. The resolver reads the
 *   session's optional `tenant` field (set only by /demos/tenants);
 *   everyone else resolves null = unscoped, zero-cost. While a tenant is
 *   active, EVERY topic the connection touches is server-side scoped to
 *   `@t/<id>/...` - the demo page says so out loud.
 * - admin: fail-closed observability plane at /__realtime/* (introspect,
 *   DLQ inspect + replay, lifeline metrics). Only admitted with a
 *   matching bearer ADMIN_TOKEN; unset token = nothing is ever admitted.
 * - protocolVersion: stale-bundle signal; pairs with configure({
 *   protocolVersion }) in the root layout.
 * - privacySecret: keys the differential-privacy noise stream for
 *   /demos/privacy's hybrid aggregate (required at init since realtime
 *   next.90; without it a subscriber could recompute and subtract the
 *   noise). Shared across replicas so they agree on the same draws. The
 *   dev fallback keeps zero-config local runs booting; real deployments
 *   must override DEMO_PRIVACY_SECRET or the noise is recomputable by
 *   anyone who reads this repo.
 */
const realtimeConfig = realtime({
	tenant: (user) => user?.tenant ?? null,
	privacySecret: env.DEMO_PRIVACY_SECRET || 'demo-privacy-noise-secret',
	admin: {
		requires: (request) =>
			Boolean(env.ADMIN_TOKEN) && request.headers.get('authorization') === `Bearer ${env.ADMIN_TOKEN}`
	},
	protocolVersion: PROTOCOL_VERSION
})

/**
 * Admin request handler (Web Request -> Response). The adapter auto-mounts
 * it on /__realtime/* ahead of the SSR catch-all when hooks.ws exports it.
 */
export const admin = realtimeConfig.admin

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

/**
 * Refusals issued by the upgrade hook below, labelled by policy reason.
 * The adapter keeps its own `upgrade_rejected_total` for the refusals it
 * makes before the hook runs (a mismatched Origin among them); both are
 * exposed on the same registry, so /metrics shows the whole admission
 * picture rather than only the half the application can see.
 */
const upgradeRefusals = metrics.counter(
	'ws_upgrade_refused_total',
	'WebSocket upgrades refused by the application upgrade hook',
	['reason']
)

/**
 * Called when a client wants to upgrade from HTTP to WebSocket.
 * Whatever this function returns becomes `ws.getUserData()` for the
 * lifetime of that connection. We attach the user's identity (looked up
 * from the session store keyed by the cookie's session-id).
 *
 * In the normal flow a session exists from the page-load HTTP visit, so
 * this hook just reads it from Redis. The legacy / fresh-connection
 * fallback mints a session on the fly so WS connections that race past
 * the HTTP cookie-set (unusual, but possible for direct wss:// clients)
 * still get a usable identity.
 *
 * `org` is optional. When set, must be one of the demo's two
 * organizations (`acme` or `globex`); used by /demos/denials to gate
 * access to org-scoped audit-log streams. Unset is treated as "no org"
 * and denies every audit:* subscribe.
 *
 * Admission runs before any of that. A handshake that carries an `Origin`
 * has already been matched against the deployment's canonical origin by the
 * adapter and refused with a 403 if it did not match, so the only decision
 * left here is the Origin-less handshake - see `$lib/server/origin-policy` for
 * why that one lands on the application. Returning `false` refuses the
 * upgrade; the adapter answers it with a 401 (it reserves 403 for its own
 * origin comparison). See `$lib/server/origin-policy`.
 */
export async function upgrade({ headers, cookies, remoteAddress }) {
	const admission = evaluateUpgradeOrigin(headers?.origin, upgradeOriginPolicy(env))
	if (!admission.allowed) {
		upgradeRefusals.inc({ reason: admission.reason })
		// Source address is recorded here and deliberately not turned into a
		// metric label: it is unbounded, and a per-address time series would
		// retain far more than a refusal count needs.
		console.warn(
			`[ws-upgrade] refused reason=${admission.reason}` +
			` origin=${headers?.origin ?? '(absent)'} ip=${remoteAddress ?? '(unknown)'}`
		)
		return false
	}

	const raw = cookies.identity

	// Fast path: session exists in Redis.
	const existing = await lookupSession(raw)
	if (existing) return existing

	// Fallback: no session yet (or legacy plain-JSON cookie from before
	// this change). Migrate legacy contents if possible, otherwise mint
	// a fresh session. Either way, write the new session-id back into
	// the cookie so the next request follows the fast path.
	const legacy = tryParseLegacyJsonCookie(raw)
	const { sessionId, identity } = await createSession(legacy)
	cookies.identity = sessionId
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
 * - `configureCron({ leader })` - gates the cron tick on the
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
export async function init({ platform }) {
	// Migrations run as an explicit pre-traffic deployment step. Refuse to
	// accept realtime traffic if the versioned jobs schema is missing.
	await activateTaskInfrastructure()
	activateRedisInfrastructure()
	await startLocalHealthServer()
	// Stash the replay extension on the source platform so realtime's
	// auto-replay routing (svelte-realtime next.21) can find the buffer
	// on every wrapped seam. `bus.wrap()` (extensions next.15) forwards
	// `.replay` via a live getter, so any per-tick / per-message
	// re-wrap also sees it.
	platform.replay = demoReplay
	// Stash the raw ioredis client so realtime's `live.room({ presence })`
	// uses its Redis-backed cluster-shared roster path instead of the
	// per-process _presenceRef Map. Without this, a room's "Online" list
	// only shows users on the same replica as the viewer; with it, the
	// roster is HGETALL-aggregated across replicas via a shared HASH
	// (`__live-presence:{topic}`).
	platform.redis = redis.redis
	// 0.6 cluster coordinators. Attached before bus.activate so every
	// bus.wrap-ed seam forwards them from the first wrapped publish:
	// - crdt: live.doc/map/array convergence + single-writer snapshots
	// - smooth: single-owner tick authority for live.smooth topics
	// - topicBroadcast: cluster-wide live.push/notify({ topic }) fan-out
	const { crdt, smooth, topicBroadcast, alarmStore, webhookControls } = redisCoordinators()
	platform.crdt = crdt
	platform.smooth = smooth
	platform.topicBroadcast = topicBroadcast
	await awaitBestEffort('Redis bus activation', () => bus.activate(platform))
	// Durable one-shot timers (live.alarm): the Redis store survives worker
	// restarts; delete() is the atomic single-fire claim shared by the
	// owning worker's precise timer and the leader's recovery poll.
	configureAlarm({ store: alarmStore, leader: () => leader.isLeader() })
	// Right to erasure (live.forget): compose every wired store that can
	// purge per-user rows. Entries without purgeUser (e.g. idempotency
	// before Postgres activation) are skipped by the composer; the DLQ
	// stamps data.userId at capture via its forgetUserId extractor.
	// The second argument hands the composer the same Redis client the
	// app stashes on platform.redis, so purgeUser also evicts the user
	// from the cluster-wide room-owner hashes and presence rosters and
	// reports each owner succession - which realtime (next.89+) then
	// announces on the affected rooms' :owner streams.
	configureForget({
		store: createForgetStore({
			registry,
			presence,
			cursor,
			rateLimit: limiter,
			replay,
			idempotency: idempotencyStore(),
			forgetDraftIdempotency,
			deadLetter: webhookControls.deadLetter
		}, { redis: redis.redis }),
		platform
	})
	// Outbound-webhook plane: fleet-shared retry budget + endpoint breaker
	// + the durable DLQ the admin plane (and /demos/outbound-webhooks)
	// inspects and replays.
	configureWebhooks({
		budget: webhookControls.budget,
		breaker: webhookControls.breaker,
		deadLetter: webhookControls.deadLetter
	})
	// Capture a complete cluster wrapper before the reactive layer replaces
	// platform.publish. The reactive surrogate cannot reconstruct production
	// adapter methods that are non-enumerable; the pressure topic has no
	// derived watchers, so publishing through this direct bus seam is correct.
	const pressurePlatform = bus.wrap(platform)
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
	// /demos/pressure has a 500ms snapshot publisher that must be armed
	// at boot rather than on first subscribe. The leader gate inside the
	// timer body means only the cluster leader actually publishes a
	// snapshot per tick -- but the gate can only fire on a worker whose
	// ticker is already running, which requires arming all workers at
	// boot. Pre-fix the ticker armed only on subscribe; if the leader
	// hadn't yet had a subscribe land on it, the snapshot was never
	// published and every subscriber's loader returned null forever.
	stopPressureTicker = armPressureTicker(pressurePlatform)
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
	// Drop task/idempotency timers before closing their shared PostgreSQL pool.
	destroyTaskInfrastructure()
	stopPressureTicker()
	stopPressureTicker = () => {}
	await Promise.allSettled([
		leader.stop(),
		presence.destroy(),
		registry.destroy(),
		destroyRedisCoordinators(),
		stopLocalHealthServer()
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
	bestEffort('Redis bus open hook', () => bus.hooks.open(ws, ctx))
	bestEffort('global presence join', () => presence.join(ws, 'global', platform))
	// Register the connection in realtime's local push registry (so
	// live.push routes via platform.request) and in the cluster registry
	// (so cross-instance pushes find this user via Redis).
	pushHooks.open(ws, ctx)
	bestEffort('connection registry open hook', () => registry.hooks.open(ws, ctx))
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
// Board presence has an explicit lifecycle: PresenceBar calls joinBoard on
// mount and leaveBoard on cleanup. BoardCard is an observer of the same
// roster, not a member. Redis presence.sync authorizes an observer by calling
// platform.checkSubscribe with the real topic; delegating that check back to
// presence.hooks.subscribe would turn every board-list observer into a member
// and make the badge stick at "1 here" after the real member leaves.
const BOARD_PRESENCE_TOPIC_RE = /^board:[^:]+$/

function usesExplicitBoardPresenceLifecycle(topic) {
	return BOARD_PRESENCE_TOPIC_RE.test(topic)
}

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
	if (usesExplicitBoardPresenceLifecycle(topic)) return
	bestEffort('presence subscribe hook', () => presence.hooks.subscribe(ws, topic, ctx))
	bestEffort('cursor subscribe hook', () => cursor.hooks.subscribe(ws, topic, ctx))
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
		if (usesExplicitBoardPresenceLifecycle(topic)) continue
		bestEffort('presence batch-subscribe hook', () => presence.hooks.subscribe(ws, topic, ctx))
		bestEffort('cursor batch-subscribe hook', () => cursor.hooks.subscribe(ws, topic, ctx))
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
	// The app owns this adapter hook, so it must explicitly chain realtime's
	// managed-topic drain (room presence, enumeration, and owner succession).
	// Extension presence cleanup is separate and remains topic-specific below.
	bestEffort('realtime unsubscribe hook', () => realtimeUnsubscribe(ws, topic, ctx))
	if (usesExplicitBoardPresenceLifecycle(topic)) return
	bestEffort('presence unsubscribe hook', () => presence.hooks.unsubscribe(ws, topic, ctx))
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
	bestEffort('presence close hook', () => presence.hooks.close(ws, ctx))
	bestEffort('cursor close hook', () => cursor.hooks.close(ws, ctx))
	// Pass ctx so pushHooks.close routes through the realtime close
	// that drains stream-subscription bookkeeping (silent-topic
	// watchdogs, _topicWsCounts, __onUnsubscribe callbacks). Without
	// the second arg, the compatibility branch keeps it
	// push-only and the silent-topic watchdog never disarms when test
	// pages close, producing 30s-delayed warning floods.
	pushHooks.close(ws, ctx)
	bestEffort('connection registry close hook', () => registry.hooks.close(ws, ctx))
	// Per-demo cleanup that needs WS context (most demos use Redis
	// for state and don't need a close hook; chaos.js keeps a
	// per-user state Map in-process that would orphan on disconnect).
	chaosOnClose(ws)
})

// Which RPCs carry per-frame transport, and so must not be charged to the
// abuse budget, lives in $lib/server/rpc-limits - matched by family rather
// than by a list of paths. See that module for why the line is drawn there.

/**
 * The message handler processes all incoming RPC calls from clients.
 * Before each RPC executes, we check the rate limit (unless it's a
 * throttled RPC like cursor movement).
 *
 * Rate limit: 100 requests per 10 seconds per user. If exceeded, the
 * client gets a RATE_LIMITED error with a countdown.
 */
export const message = createMessage({
	// No `platform` callback: svelte-realtime 0.5.7 owns cluster routing
	// at every publish seam via the process-wide bus that
	// `configureCron({ bus })` set above. The framework installs a
	// single idempotent wrap (`_ensureWrap`) and there is exactly one
	// `bus.wrap(...)` call inside the framework, so RPC ctx.publish
	// relays via one path. A manual `(p) => bus.wrap(p)` here would
	// stack on top of that inner wrap and double-relay every publish
	// (the 0.5.6 audit / notifications counted 2x in /demos/effect on a
	// two-replica deploy).
	async beforeExecute(ws, rpcPath) {
		if (isPerFrameRpc(rpcPath)) return
		const { allowed, resetMs } = await limiter.consume(ws)
		if (!allowed) throw new LiveError('RATE_LIMITED', `Retry in ${Math.ceil(resetMs / 1000)}s`)
	},
	// Catch wire frames that don't match the RPC shape and route them to
	// the extension plugins that own them. Today:
	//
	//   {type:'cursor', topic, data}        -> cursor.hooks.message
	//     Adapter's `move(topic, data)` helper sends this on every cursor
	//     update. Bypasses the realtime RPC pipeline entirely for the
	//     cursor hot path -- no RPC id allocation, no pending-promise map
	//     entry, no timeout timer, no devtools/dedup.
	//
	//   {type:'presence-snapshot', topic}   -> presence.hooks.message
	//     Adapter's presence client sends this on every status==='open'
	//     (initial connect + reconnect). The handler re-emits
	//     `presence_state` to the requesting ws so board-scoped presence
	//     does not stay stale across reconnects.
	//
	// createMessage's onUnhandled gets the raw ArrayBuffer (same shape
	// handleRpc expects), so we parse here before dispatching. Reject
	// silently on non-JSON / non-object frames -- those would just be
	// noise from instrumentation or buggy clients. Each plugin's hook
	// no-ops on frames whose `type` it does not own, so dispatching to
	// both is safe.
	onUnhandled(ws, data, platform) {
		if (!(data instanceof ArrayBuffer) || data.byteLength < 2) return
		let parsed
		try { parsed = JSON.parse(_unhandledDecoder.decode(data)) } catch { return }
		if (!parsed || typeof parsed !== 'object') return
		if (parsed.type === 'cursor-snapshot' && typeof parsed.topic === 'string') {
			// The installed cursor hook starts this Promise without returning it;
			// dispatch directly so an outage cannot become an unhandled rejection.
			bestEffort('cursor snapshot hook', () => cursor.snapshot(ws, parsed.topic, platform))
		} else {
			bestEffort('cursor message hook', () => cursor.hooks.message(ws, { data: parsed, platform }))
		}
		bestEffort('presence message hook', () => presence.hooks.message(ws, { data: parsed, platform }))
	}
})

// Module-scoped decoder to avoid allocating one per frame on the hot path.
const _unhandledDecoder = new TextDecoder()

/**
 * Adapter session-resume hook. Fires on WebSocket reconnect when the
 * client presents its previous sessionId + per-topic lastSeenSeqs.
 * The replay extension's resumeHook iterates the topics and gap-fills
 * each via the existing __replay:{topic} pipeline. Without this hook,
 * reconnects fall through to live mode and the client refetches via
 * initial subscribe (visible flicker on a busy board).
 */
export const resume = replay.resumeHook()
