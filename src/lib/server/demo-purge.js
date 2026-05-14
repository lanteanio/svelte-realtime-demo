/**
 * Automatic purge of demo user-content on a fixed interval.
 *
 * Two cron schedules:
 *
 *  - General purge (text content): every DEMO_PURGE_INTERVAL_MIN
 *    minutes (default 30). Covers chat, notifications, auctions,
 *    effect, jobs, denials, todos, pagination, news.
 *
 *  - Upload purge (binary content): every
 *    DEMO_UPLOAD_PURGE_INTERVAL_MIN minutes (default 5). Separate
 *    schedule because uploaded files are a higher-risk vector
 *    (CSAM, copyrighted material, malware) than typed text. Wipes
 *    the in-memory file index, the chunk buffer, and the Redis chunk
 *    idempotency keyspace.
 *
 * Both crons inherit cluster-singleton semantics from the global
 * `live.configureCron({ leader })` wiring in src/hooks.ws.js, so each
 * fires exactly once per interval across the whole cluster.
 *
 * Interval validation: requested value must be in 1..60 and divide 60
 * evenly so the cron step syntax behaves. Out-of-range values fall
 * back to the default. Setting either env var to 0 disables that cron
 * (the documented kill-switch).
 *
 * Importing this module eagerly loads every demo with a purge surface,
 * which also registers their own crons (notifications scheduler, jobs
 * refresh, news firehose, cluster-cron tick) at boot rather than at
 * first page visit. That is intentional: a deployed demo gallery
 * should have its background machinery running from boot regardless
 * of which page someone happens to visit first.
 *
 * Skipped demos: checkout, counter-resume, pressure, chaos, topk,
 * schema-evolution, flash-sales, from-seq, cluster-cron - none of them
 * accept user content into persistent state, only read-only counters
 * or pre-seeded data.
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

function resolveInterval(raw, fallback) {
	const n = Number.isFinite(raw) ? Math.floor(raw) : fallback
	if (n === 0) return 0
	if (n >= 1 && n <= 60 && 60 % n === 0) return n
	return fallback
}

const INTERVAL_MIN = resolveInterval(Number(env.DEMO_PURGE_INTERVAL_MIN), 30)
const UPLOAD_INTERVAL_MIN = resolveInterval(Number(env.DEMO_UPLOAD_PURGE_INTERVAL_MIN), 5)

const TARGETS = [
	['chat',          purgeChat],
	['notifications', purgeNotifications],
	['auctions',      purgeAuctions],
	['effect',        purgeEffect],
	['jobs',          purgeJobs],
	['denials',       purgeDenials],
	['todos',         purgeTodos],
	['pagination',    purgePagination],
	['news',          purgeNews]
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
export const purgeAllDemos = INTERVAL_MIN > 0
	? live.cron(`*/${INTERVAL_MIN} * * * *`, TOPICS.demoPurgeTick, async (ctx) => {
		await runAll(ctx)
	})
	: null

export const purgeUploadCron = UPLOAD_INTERVAL_MIN > 0
	? live.cron(`*/${UPLOAD_INTERVAL_MIN} * * * *`, TOPICS.demoPurgeTick, async (ctx) => {
		try {
			const result = await purgeUpload(ctx)
			console.log(`[demo-purge] upload tick at ${new Date().toISOString()}`, result)
		} catch (err) {
			console.log(`[demo-purge] upload tick failed at ${new Date().toISOString()}: ${err?.message ?? err}`)
		}
	})
	: null

console.log(
	`[demo-purge] general=${INTERVAL_MIN === 0 ? 'disabled' : `every ${INTERVAL_MIN} min`}, ` +
	`upload=${UPLOAD_INTERVAL_MIN === 0 ? 'disabled' : `every ${UPLOAD_INTERVAL_MIN} min`}`
)
