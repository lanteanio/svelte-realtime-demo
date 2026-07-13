/**
 * Automatic purge of demo user-content on a fixed interval.
 *
 * This module lives under src/live/ ON PURPOSE: the realtime Vite codegen
 * only scans src/live/ for exports to emit into the cron registry the runtime
 * ticks. A live.cron() defined anywhere else (this file's previous home was
 * src/lib/server/demo-purge.js) attaches its schedule metadata but is never
 * registered, so it never fires. The codegen matches an exported const bound
 * directly to a live.cron(...) call - hence the two crons below are declared
 * unconditionally in that exact shape, and the env kill-switch is enforced
 * inside each handler rather than by returning null from a ternary (which the
 * codegen regex would not match, silently un-registering the cron again).
 *
 * Two cron schedules:
 *
 *  - General purge (text content): every DEMO_PURGE_INTERVAL_MIN minutes
 *    (default 30). Covers chat, notifications, auctions, effect, jobs,
 *    denials, todos, pagination, news, offline, tenants, flags,
 *    outbound-webhooks, phases.
 *
 *  - Upload purge (binary content): every DEMO_UPLOAD_PURGE_INTERVAL_MIN
 *    minutes (default 5). Separate schedule because uploaded files are a
 *    higher-risk vector (CSAM, copyrighted material, malware) than typed
 *    text. Wipes the in-memory file index, the chunk buffer, and the Redis
 *    chunk idempotency keyspace.
 *
 * Both crons inherit cluster-singleton semantics from the global
 * `live.configureCron({ leader })` wiring in src/hooks.ws.js, so each fires
 * exactly once per interval across the whole cluster.
 *
 * Interval validation: requested value must be in 1..60 and divide 60 evenly
 * so the cron step syntax behaves. Out-of-range values fall back to the
 * default. Setting either env var to 0 DISABLES that cron (the documented
 * kill-switch): the export still registers (and ticks on its fallback
 * schedule), but the handler returns before doing any work.
 *
 * Importing this module eagerly loads every demo with a purge surface, which
 * also runs their module bodies (notifications scheduler, jobs refresh, news
 * firehose, cluster-cron tick) at boot rather than at first page visit. That
 * is intentional: a deployed demo gallery should have its background
 * machinery running from boot regardless of which page someone visits first.
 *
 * Skipped demos: checkout, counter-resume, pressure, chaos, topk,
 * schema-evolution, flash-sales, from-seq, cluster-cron - none of them accept
 * user content into persistent state, only read-only counters or pre-seeded
 * data. Also skipped by design: alarms, forget, and privacy keep their state
 * in TTL'd Redis keys; collab-editor's doc snapshot carries a 24h Redis TTL;
 * arena, shooter, lobbies, multiplayer, and ops hold only ephemeral in-memory
 * state. kanban has no purge yet and its shared board is unbounded - if it
 * attracts abuse, drop the CRDT topic on a cron via the authority's
 * drop(topic) primitive.
 */

import { live } from 'svelte-realtime/server'
import { env } from '$env/dynamic/private'
import { TOPICS } from '$lib/server/topics'
import { purge as purgeChat } from '$live/demos/chat'
import { purge as purgeNotifications } from '$live/demos/notifications'
import { purge as purgeAuctions } from '$live/demos/auctions'
import { purge as purgeEffect } from '$live/demos/effect'
import { purge as purgeJobs } from '$live/demos/jobs'
import { purge as purgeDenials } from '$live/demos/denials'
import { purge as purgeTodos } from '$live/demos/todos-rollback'
import { purge as purgePagination } from '$live/demos/pagination'
import { purge as purgeNews } from '$live/demos/news'
import { purge as purgeUpload } from '$live/demos/upload'
import { purge as purgeOffline } from '$live/demos/offline'
import { purge as purgeTenants } from '$live/demos/tenants'
import { purge as purgeFlags } from '$live/demos/flags'
import { purge as purgeOutbound } from '$live/demos/outbound-webhooks'
import { purge as purgePhases } from '$live/demos/phases'

function resolveInterval(raw, fallback) {
	const n = Number.isFinite(raw) ? Math.floor(raw) : fallback
	if (n === 0) return 0
	if (n >= 1 && n <= 60 && 60 % n === 0) return n
	return fallback
}

const INTERVAL_MIN = resolveInterval(Number(env.DEMO_PURGE_INTERVAL_MIN), 30)
const UPLOAD_INTERVAL_MIN = resolveInterval(Number(env.DEMO_UPLOAD_PURGE_INTERVAL_MIN), 5)

// Cron schedules are always a VALID step expression so the export registers
// even when the interval is disabled (0); a disabled cron falls back to the
// default cadence for the syntax and no-ops in its handler.
const GENERAL_STEP = INTERVAL_MIN > 0 ? INTERVAL_MIN : 30
const UPLOAD_STEP = UPLOAD_INTERVAL_MIN > 0 ? UPLOAD_INTERVAL_MIN : 5

const TARGETS = [
	['chat',          purgeChat],
	['notifications', purgeNotifications],
	['auctions',      purgeAuctions],
	['effect',        purgeEffect],
	['jobs',          purgeJobs],
	['denials',       purgeDenials],
	['todos',         purgeTodos],
	['pagination',    purgePagination],
	['news',          purgeNews],
	['offline',       purgeOffline],
	['tenants',       purgeTenants],
	['flags',         purgeFlags],
	['outbound',      purgeOutbound],
	['phases',        purgePhases]
]

async function runAll(ctx) {
	const results = await Promise.allSettled(TARGETS.map(([, fn]) => fn(ctx)))
	const summary = {}
	let failed = 0
	results.forEach((r, i) => {
		const [name] = TARGETS[i]
		if (r.status === 'fulfilled') {
			summary[name] = r.value ?? 'ok'
		} else {
			summary[name] = { error: r.reason?.message ?? String(r.reason) }
			failed++
		}
	})
	console.log(`[demo-purge] tick at ${new Date().toISOString()} (failed=${failed})`, summary)
}

// Both crons return undefined to suppress auto-publish on demoPurgeTick.
// The cron registry keys by export path, so sharing the topic is safe.
export const purgeAllDemos = live.cron(`*/${GENERAL_STEP} * * * *`, TOPICS.demoPurgeTick, async (ctx) => {
	if (INTERVAL_MIN === 0) return // disabled via DEMO_PURGE_INTERVAL_MIN=0
	await runAll(ctx)
})

export const purgeUploadCron = live.cron(`*/${UPLOAD_STEP} * * * *`, TOPICS.demoPurgeTick, async (ctx) => {
	if (UPLOAD_INTERVAL_MIN === 0) return // disabled via DEMO_UPLOAD_PURGE_INTERVAL_MIN=0
	try {
		const result = await purgeUpload(ctx)
		console.log(`[demo-purge] upload tick at ${new Date().toISOString()}`, result)
	} catch (err) {
		console.log(`[demo-purge] upload tick failed at ${new Date().toISOString()}: ${err?.message ?? err}`)
	}
})

console.log(
	`[demo-purge] general=${INTERVAL_MIN === 0 ? 'disabled' : `every ${INTERVAL_MIN} min`}, ` +
	`upload=${UPLOAD_INTERVAL_MIN === 0 ? 'disabled' : `every ${UPLOAD_INTERVAL_MIN} min`}`
)
