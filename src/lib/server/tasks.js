/**
 * Postgres-backed task runner wiring for /demos/jobs.
 *
 * Three extensions primitives compose here:
 *
 *  - createPgClient  : the runner needs a PgClient (Pool + query
 *                      shorthand + lifecycle). It wraps db.js's shared
 *                      process-wide Pool, so the worker has one explicit
 *                      PostgreSQL connection budget and one shutdown owner.
 *
 *  - createTaskRunner: the durable task framework. Its tables are created
 *                      by the versioned pre-deploy migration; runtime DDL is
 *                      disabled. The runner owns
 *                      internal dispatch + recovery + cleanup sweeps.
 *                      Demo time scales (fenceTtl 10s, heartbeat 1.5s,
 *                      recovery 2s, dispatch 1s) so force-takeover and
 *                      retry flows are visible inside an e2e test run.
 *
 *  - createRedisFence: optional second source of truth for fence
 *                      validity. `tasks.takeover(taskId)` uses
 *                      both: expires the Postgres fence AND releases
 *                      the Redis mirror so the in-flight handler aborts
 *                      on the very next heartbeat tick.
 *
 * The runner depends on env.DATABASE_URL; Redis is optional and only enables
 * the second fence source. Without PostgreSQL, `tasks` stays null and the demo
 * page gracefully shows a "Postgres required" placeholder.
 *
 * Runtime init registers `simulate-work` before any RPC is accepted. The
 * handler honors AbortSignal so a heartbeat-detected fence loss bails
 * immediately.
 */

import { createPgClient } from 'svelte-adapter-uws-extensions/postgres'
import { createTaskRunner } from 'svelte-adapter-uws-extensions/postgres/tasks'
import { createIdempotencyStore } from 'svelte-adapter-uws-extensions/postgres/idempotency'
import { createRedisFence } from 'svelte-adapter-uws-extensions/redis/fence'
import { env } from '$env/dynamic/private'
import { databasePool } from '$lib/server/db'
import { redis } from '$lib/server/redis'
import { metrics } from '$lib/server/metrics'

export const TASKS_TABLE = 'demos_jobs_tasks'
export const TASKS_IDEMPOTENCY_TABLE = 'demos_jobs_idempotency'

/**
 * PgClient for the demo. Null if DATABASE_URL is empty - the demo
 * page detects this and renders a "Postgres required" panel.
 */
export let pgClient = null
export let tasks = null
let idempotency = null
let activationPromise = null

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

/**
 * Construct timer-owning task primitives only from the adapter runtime init
 * hook. This keeps Vite's build analysis free of PostgreSQL connections and
 * background sweeps. The preflight SELECTs are DDL-free and fail startup if a
 * deployment skipped the versioned migration.
 */
export function activateTaskInfrastructure() {
	if (!env.DATABASE_URL) return Promise.resolve()
	if (activationPromise) return activationPromise

	activationPromise = (async () => {
		pgClient = createPgClient({ pool: databasePool, connectionString: env.DATABASE_URL })
		await Promise.all([
			pgClient.query(`SELECT 1 FROM ${TASKS_TABLE} LIMIT 0`),
			pgClient.query(`SELECT 1 FROM ${TASKS_IDEMPOTENCY_TABLE} LIMIT 0`)
		])

		const fence = env.REDIS_URL ? createRedisFence(redis) : null
		idempotency = createIdempotencyStore(pgClient, {
			table: TASKS_IDEMPOTENCY_TABLE,
			autoMigrate: false,
			ttl: 60 * 60,
			cleanupInterval: 5 * 60 * 1000
		})

		// Time scales tuned for the demo: fence loss + recovery happen within
		// seconds so force-takeover is visible.
		tasks = createTaskRunner(pgClient, {
			table: TASKS_TABLE,
			autoMigrate: false,
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
		tasks.register('simulate-work', simulateWork, {
			retry: {
				maxAttempts: 3,
				backoff: (attempt) => 250 * attempt
			}
		})
	})()

	return activationPromise
}

/**
 * The active idempotency store, or null before activation / without
 * Postgres. Composed into the forget-store so live.forget can purge a
 * user's cached RPC results.
 */
export function idempotencyStore() {
	return idempotency
}

/** Stop every timer owned by the task and idempotency primitives. */
export function destroyTaskInfrastructure() {
	tasks?.destroy()
	idempotency?.destroy()
}
