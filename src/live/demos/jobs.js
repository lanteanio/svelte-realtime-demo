// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/jobs - durable Postgres-backed task runner with Redis fence,
 * retry policy, force-takeover, and a live.cron-driven stats / list
 * refresh tick.
 *
 * The pitch: submit a "simulate work" task with a chosen duration and
 * outcome mode (succeed / fail-once / fail-always). The task lands in
 * the `demos_jobs_tasks` Postgres table; a dispatch sweep claims it
 * and runs the registered handler. While it runs, a heartbeat refreshes
 * the per-attempt fence in Postgres AND in Redis. Click "Force takeover"
 * on a running row and `tasks.takeover(taskId)` expires the
 * Postgres fence + releases the Redis mirror; the original handler
 * aborts via AbortSignal on its very next heartbeat tick. The retry
 * policy then re-arms the task; if mode = fail-once, the second
 * attempt commits.
 *
 * Four primitives in one demo:
 *
 *  - createTaskRunner (postgres/tasks): registered task with retry
 *    policy. run() is inline; enqueue() lets the dispatch sweep claim
 *    rows asynchronously so the page stays responsive while the
 *    handler runs. tasks.list() / tasks.counts() / tasks.takeover()
 *    are the public observability + operator surface; we use them
 *    instead of raw SQL so the demo is decoupled from the runner's
 *    internal column names.
 *
 *  - createRedisFence (redis/fence): paired with the task runner so
 *    fence-loss is detected on every heartbeat tick from BOTH
 *    Postgres AND Redis. Force-takeover is the visible reproducer.
 *
 *  - createIdempotencyStore (postgres/idempotency): caller retry
 *    dedup, wired into the runner. Repeating an enqueue with the
 *    same idempotency key returns the cached result instead of
 *    queuing a duplicate.
 *
 *  - live.cron (svelte-realtime): 1Hz tick that re-reads the table
 *    via tasks.list() / tasks.counts() and publishes both snapshots.
 *    Polling beats LISTEN/NOTIFY plumbing for a demo; the 
 *    `onStateChange` callback would replace the polling pattern in
 *    production for instant per-row reactivity.
 *
 * Storage is in `demos_jobs_tasks` (created by the versioned pre-traffic
 * migration; runtime DDL is disabled). Demo-friendly: rowTtl = 10 minutes,
 * cleanup every 5 minutes.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { tasks, pgClient, TASKS_TABLE } from '$lib/server/tasks'

const VALID_MODES = new Set(['succeed', 'fail-once', 'fail-always'])
const TASK_NAME = 'simulate-work'
const LIST_LIMIT = 30

function postgresAvailable() {
	return tasks !== null && pgClient !== null
}

/**
 * Page-load probe. The page reads `available` to decide whether to
 * render the demo or a "Postgres required" placeholder. Shape mirrors
 * the other demos' my{Foo}State convention.
 */
export const myJobsState = live(async () => ({
	available: postgresAvailable(),
	fenceEnabled: postgresAvailable() && Boolean(process.env.REDIS_URL),
	modes: Array.from(VALID_MODES),
	listLimit: LIST_LIMIT
}))

/**
 * Read the most recent N task rows. Wraps `tasks.list()` (the
 * public observability API) with the JSON-friendly transform the
 * client expects: Date instances become ms numbers so the wire
 * payload survives JSON.stringify without ISO-string drift in the
 * page's number arithmetic.
 *
 * The `fence` UUID is intentionally not exposed by `tasks.list()` --
 * internal-only, no caller value.
 */
async function readJobs(limit = LIST_LIMIT) {
	if (!tasks) return []
	const rows = await tasks.list({ name: TASK_NAME, limit })
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		input: r.input,
		status: r.status,
		result: r.result,
		error: r.error,
		attempts: r.attempts,
		createdAt: r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt) || 0,
		updatedAt: r.updatedAt instanceof Date ? r.updatedAt.getTime() : Number(r.updatedAt) || 0,
		fenceExpiresAt: r.fenceExpiresAt instanceof Date ? r.fenceExpiresAt.getTime() : Number(r.fenceExpiresAt) || 0
	}))
}

/**
 * Read aggregated status counts. Direct pass-through of `tasks.counts()`
 * which already returns the full {pending, running, committed, failed,
 * total} shape with zero buckets included.
 */
async function readStats() {
	const empty = { pending: 0, running: 0, committed: 0, failed: 0, total: 0 }
	if (!tasks) return empty
	return tasks.counts({ name: TASK_NAME })
}

/**
 * Enqueue a simulate-work task. Returns the task id immediately; the
 * dispatch sweep picks it up within ~1s and runs the handler in the
 * background. Pair with the live stream subscription to watch its
 * status transitions.
 */
export const enqueueJob = live(async (ctx, args) => {
	if (!tasks) throw new LiveError('UNAVAILABLE', 'Postgres required for /demos/jobs')
	const durationMs = Math.max(200, Math.min(15_000, Math.round(Number(args?.durationMs) || 1000)))
	const mode = VALID_MODES.has(args?.mode) ? args.mode : 'succeed'
	const idempotencyKey = typeof args?.idempotencyKey === 'string' && args.idempotencyKey.length > 0
		? args.idempotencyKey
		: undefined

	const taskId = await tasks.enqueue(TASK_NAME, {
		input: { durationMs, mode },
		idempotencyKey
	})
	// Push the new row to subscribers immediately so the UI doesn't
	// wait for the next 1Hz refresh tick.
	ctx.publish(TOPICS.demoJobsList, 'set', await readJobs())
	ctx.publish(TOPICS.demoJobsStats, 'set', await readStats())
	return { ok: true, taskId }
})

/**
 * Force a running attempt to abort. Promotes the documented "drain
 * this instance" pattern from raw-SQL hack to a public API call:
 * `tasks.takeover(taskId)` expires the Postgres fence AND releases
 * the Redis mirror so the in-flight handler aborts on its very next
 * heartbeat tick. The recovery sweep then reclaims the row and
 * re-drives the handler under the registered retry policy.
 *
 * Returns `false` for rows that aren't running (already terminal,
 * never existed, or somebody else expired it first); a double-click
 * is a no-op rather than a 4xx.
 */
export const forceTakeover = live(async (ctx, taskId) => {
	if (!tasks) throw new LiveError('UNAVAILABLE', 'Postgres required')
	if (typeof taskId !== 'string' || taskId.length === 0) {
		throw new LiveError('VALIDATION', 'taskId required')
	}
	const takenOver = await tasks.takeover(taskId)
	if (takenOver) {
		ctx.publish(TOPICS.demoJobsList, 'set', await readJobs())
	}
	return { ok: true, takenOver }
})

/**
 * Clear all simulate-work task rows. Demo escape hatch so the gallery
 * doesn't accumulate stale rows between sessions. TRUNCATE-equivalent
 * but scoped to the demo's task name so any other named tasks (none
 * today, but the table is shared if more demos ever land) stay put.
 */
export const clearJobs = live(async (ctx) => {
	if (!pgClient) throw new LiveError('UNAVAILABLE', 'Postgres required')
	await pgClient.query(`DELETE FROM ${TASKS_TABLE} WHERE name = $1`, [TASK_NAME])
	ctx.publish(TOPICS.demoJobsList, 'set', [])
	ctx.publish(TOPICS.demoJobsStats, 'set', await readStats())
	return { ok: true }
})

/**
 * DELETE every simulate-work row. Same SQL as clearJobs; safe even
 * when a row is mid-run because the registered handler's heartbeat
 * detects the missing fence on the next tick and aborts. Postgres
 * unavailable -> no-op (the demo never wrote anything).
 */
export async function purge(ctx) {
	if (!pgClient) return { available: false }
	const res = await pgClient.query(`DELETE FROM ${TASKS_TABLE} WHERE name = $1`, [TASK_NAME])
	ctx.publish(TOPICS.demoJobsList, 'set', [])
	ctx.publish(TOPICS.demoJobsStats, 'set', await readStats())
	return { deleted: res?.rowCount ?? 0 }
}

/**
 * Live stream of the recent task list. `merge: 'set'` because each
 * publish replaces the entire list - simpler than tracking per-row
 * crud events when the runner's state machine is internal.
 */
export const jobsList = live.stream(
	TOPICS.demoJobsList,
	async () => readJobs(),
	{ merge: 'set' }
)

/**
 * Live stream of status counts. Same set-replace shape; the page
 * renders a five-cell strip from the snapshot.
 */
export const jobsStats = live.stream(
	TOPICS.demoJobsStats,
	async () => readStats(),
	{ merge: 'set' }
)

/**
 * 1Hz refresh tick. Re-reads the runner's table via the public
 * tasks.list() / tasks.counts() API and publishes both snapshots
 * so subscribers see status transitions (pending -> running ->
 * committed/failed) without a per-event trigger. Polling is fine
 * for a demo at this scale; the `onStateChange` callback
 * is the production-shape alternative for instant per-row updates.
 *
 * The cron always runs (no postgresAvailable() gate) so the stream
 * loaders return a non-empty placeholder shape even when DB is down;
 * the page reads myJobsState().available to decide what to render.
 */
export const refreshTick = live.cron('* * * * * *', TOPICS.demoJobsList, async (ctx) => {
	if (!postgresAvailable()) return
	ctx.publish(TOPICS.demoJobsList, 'set', await readJobs())
	ctx.publish(TOPICS.demoJobsStats, 'set', await readStats())
})
