/**
 * Dependency-aware readiness shared by the public health route and the
 * per-container Unix-socket probe. Raw dependency errors and connection
 * strings never leave this module.
 */

import { env } from '$env/dynamic/private'
import { databasePool } from '$lib/server/db'
import { breaker, redis } from '$lib/server/redis'

const REQUIRED_MIGRATIONS = [
	'001_application_schema.sql',
	'002_demo_jobs.sql',
	'003_demo_jobs_erasure_columns.sql'
]
const DEFAULT_TIMEOUT_MS = 2500

function timeoutMs(value) {
	const parsed = Number(value)
	return Number.isInteger(parsed) && parsed >= 250 && parsed <= 10_000
		? parsed
		: DEFAULT_TIMEOUT_MS
}

const READINESS_TIMEOUT_MS = timeoutMs(process.env.READINESS_TIMEOUT_MS)

async function withinBudget(operation) {
	let timer
	try {
		return await Promise.race([
			operation,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('readiness timeout')), READINESS_TIMEOUT_MS)
				if (timer.unref) timer.unref()
			})
		])
	} finally {
		clearTimeout(timer)
	}
}

async function checkPostgres() {
	if (!env.DATABASE_URL || !databasePool) return { status: 'disabled', latencyMs: 0 }
	const started = performance.now()
	try {
		const result = await withinBudget(databasePool.query({
			text: `
				SELECT count(*)::integer AS applied
				  FROM schema_migration
				 WHERE schema_migration_id = ANY($1::text[])
				   AND to_regclass('public.board') IS NOT NULL
				   AND to_regclass('public.note') IS NOT NULL
				   AND to_regclass('public.demos_jobs_tasks') IS NOT NULL
				   AND to_regclass('public.demos_jobs_idempotency') IS NOT NULL
			`,
			values: [REQUIRED_MIGRATIONS],
			query_timeout: READINESS_TIMEOUT_MS
		}))
		const ready = result.rows[0]?.applied === REQUIRED_MIGRATIONS.length
		return {
			status: ready ? 'ok' : 'schema-pending',
			latencyMs: Math.round(performance.now() - started)
		}
	} catch {
		return { status: 'down', latencyMs: Math.round(performance.now() - started) }
	}
}

async function checkRedis() {
	if (!env.REDIS_URL) return { status: 'disabled', latencyMs: 0 }
	const started = performance.now()
	try {
		const response = await withinBudget(redis.redis.ping())
		const status = response !== 'PONG'
			? 'down'
			: breaker.isHealthy ? 'ok' : 'recovering'
		return {
			status,
			latencyMs: Math.round(performance.now() - started)
		}
	} catch {
		return { status: 'down', latencyMs: Math.round(performance.now() - started) }
	}
}

export async function checkReadiness() {
	const [postgres, redisCheck] = await Promise.all([checkPostgres(), checkRedis()])
	const acceptable = new Set(['ok', 'disabled'])
	const ok = acceptable.has(postgres.status) && acceptable.has(redisCheck.status)
	return {
		status: ok ? 'ok' : 'not-ready',
		checks: { postgres, redis: redisCheck }
	}
}
