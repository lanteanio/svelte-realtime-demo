/**
 * SvelteKit server-side hooks.
 *
 * handleError: catches unhandled errors during SSR and API routes.
 *
 * The top-level init runs once when this module first loads (server startup).
 * It migrates the schema if needed, then ensures well-known boards exist
 * (like the stress test board used by the E2E suite).
 */

import { ensureBoard } from '$lib/server/db'
import pg from 'pg'
import { env } from '$env/dynamic/private'

if (env.DATABASE_URL) {
	const pool = new pg.Pool({ connectionString: env.DATABASE_URL })
	pool.query(`
		ALTER TABLE board ADD COLUMN IF NOT EXISTS last_activity timestamptz DEFAULT now() NOT NULL
	`).then(() => pool.end()).then(() => {
		// Wait for migration before creating boards that reference last_activity
		return ensureBoard({ title: 'stress', slug: 'stress-me-out' })
	}).catch((err) => {
		console.warn('Startup warning:', err.message)
	})
} else {
	ensureBoard({ title: 'stress', slug: 'stress-me-out' }).catch((err) => {
		console.warn('Could not ensure stress test board:', err.message)
	})
}

export function handleError({ error }) {
	console.error('[handleError]', error)
}
