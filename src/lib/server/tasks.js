/**
 * Postgres-backed task runner wiring for /demos/jobs.
 *
 * Three extensions primitives compose here:
 *
 *  - createPgClient  : the runner needs a PgClient (Pool + query
 *                      shorthand + lifecycle). We open a separate pool
 *                      from the one in db.js for now; the next.8
 *                      `createPgClient({ pool })` overload would let
 *                      us share, but that requires exposing db.js's
 *                      module-scope pool first. Two-pool footprint is
 *                      harmless at demo scale. Auto-shutdown hooks
 *                      into SvelteKit's lifecycle.
 *
 *  - createTaskRunner: the durable task framework. Auto-migrates
 *                      `svti_tasks` at construction (next.8); runs
 *                      internal dispatch + recovery + cleanup sweeps.
 *                      Demo time scales (fenceTtl 10s, heartbeat 1.5s,
 *                      recovery 2s, dispatch 1s) so force-takeover and
 *                      retry flows are visible inside an e2e test run.
 *
 *  - createRedisFence: optional second source of truth for fence
 *                      validity. `tasks.takeover(taskId)` (next.8) uses
 *                      both: expires the Postgres fence AND releases
 *                      the Redis mirror so the in-flight handler aborts
 *                      on the very next heartbeat tick.
 *
 * All three depend on env.DATABASE_URL (and Redis for the fence). Any
 * absent dependency makes `tasks` null; the demo page gracefully shows
 * a "Postgres required" placeholder.
 *
 * Registers the `simulate-work` task at module load so it is ready
 * before any RPC fires. The handler honors the AbortSignal so a
 * heartbeat-detected fence loss bails immediately.
 */

import { createPgClient } from 'svelte-adapter-uws-extensions/postgres'
import { createTaskRunner } from 'svelte-adapter-uws-extensions/postgres/tasks'
import { createIdempotencyStore } from 'svelte-adapter-uws-extensions/postgres/idempotency'
import { createRedisFence } from 'svelte-adapter-uws-extensions/redis/fence'
import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { metrics } from '$lib/server/metrics'

export const TASKS_TABLE = 'demos_jobs_tasks'
export const TASKS_IDEMPOTENCY_TABLE = 'demos_jobs_idempotency'

/**
 * PgClient for the demo. Null if DATABASE_URL is empty - the demo
 * page detects this and renders a "Postgres required" panel.
 */
export const pgClient = env.DATABASE_URL
	? createPgClient({ connectionString: env.DATABASE_URL })
	: null

const fence = pgClient && env.REDIS_URL
	? createRedisFence(redis)
	: null

const idempotency = pgClient
	? createIdempotencyStore(pgClient, {
			table: TASKS_IDEMPOTENCY_TABLE,
			ttl: 60 * 60,
			cleanupInterval: 5 * 60 * 1000
		})
	: null

/**
 * The task runner. Time scales tuned for the demo: fence loss + recovery
 * happen within seconds so force-takeover is visible.
 */
export const tasks = pgClient
	? createTaskRunner(pgClient, {
			table: TASKS_TABLE,
			idempotency,
			fence,
			fenceTtl: 10,
			heartbeatInterval: 1500,
			recoveryInterval: 2000,
			recoveryBatchSize: 5,
			dispatchInterval: 1000,
			dispatchBatchSize: 5,
			cleanupInterval: 5 * 60 * 1000,
			rowTtl: 10 * 60,
			metrics
		})
	: null

/**
 * Demo task handler. Sleeps in 200ms ticks so an aborted fence (force-
 * takeover) bails within one tick instead of the full configured
 * duration. The mode parameter controls deterministic outcomes:
 *
 *   succeed     : always commit
 *   fail-once   : throw on attempt 1, commit on retry (with retry policy)
 *   fail-always : throw every attempt - exhausts retries, lands `failed`
 *
 * Returns a small JSON result so the page can render "what came back."
 */
async function simulateWork(ctx) {
	const input = ctx.input ?? {}
	const durationMs = Math.max(200, Math.min(30_000, Number(input.durationMs) || 1000))
	const mode = input.mode === 'fail-once' || input.mode === 'fail-always' ? input.mode : 'succeed'
	const tick = 200
	const ticks = Math.ceil(durationMs / tick)
	for (let i = 0; i < ticks; i++) {
		if (ctx.signal.aborted) {
			throw new Error('aborted (fence lost)')
		}
		await new Promise((r) => setTimeout(r, tick))
	}
	if (mode === 'fail-once' && ctx.attempt === 1) {
		throw new Error('intentional first-attempt failure')
	}
	if (mode === 'fail-always') {
		throw new Error('intentional always-fail')
	}
	return {
		ok: true,
		mode,
		durationMs,
		attempt: ctx.attempt,
		finishedAt: Date.now()
	}
}

if (tasks) {
	tasks.register('simulate-work', simulateWork, {
		retry: {
			maxAttempts: 3,
			backoff: (attempt) => 250 * attempt
		}
	})
	// next.8 fires autoMigrate at construction, but the cron tick may
	// run before it lands. Surface a clean "ready" log so any boot-time
	// migration error is visible; downstream code uses tasks.list() /
	// tasks.counts() which await the same migration internally.
	tasks
		.ready()
		.catch((err) => console.warn('[demos/jobs] tasks.ready() warning:', err?.message ?? err))
}
