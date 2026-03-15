/**
 * SvelteKit server-side hooks.
 *
 * handleError: catches unhandled errors during SSR and API routes.
 *
 * The top-level ensureBoard call runs once when this module first loads
 * (server startup). It creates well-known boards that should always exist,
 * like the stress test board used by the E2E suite.
 */

import { ensureBoard } from '$lib/server/db'
import pg from 'pg'
import { env } from '$env/dynamic/private'

// Run migration: add last_activity column if it doesn't exist.
// Safe to run on every startup -- IF NOT EXISTS is a no-op.
if (env.DATABASE_URL) {
	const pool = new pg.Pool({ connectionString: env.DATABASE_URL })
	pool.query(`
		ALTER TABLE board ADD COLUMN IF NOT EXISTS last_activity timestamptz DEFAULT now() NOT NULL
	`).then(() => {
		return pool.query(`UPDATE board SET last_activity = created_at WHERE last_activity = created_at`)
	}).then(() => pool.end()).catch((err) => {
		console.warn('Migration warning:', err.message)
		pool.end()
	})
}

// Ensure the stress test board exists on every deploy.
// Safe to call multiple times -- it's a no-op if the board already exists.
ensureBoard({ title: 'stress', slug: 'stress-me-out' }).catch((err) => {
	console.warn('Could not ensure stress test board:', err.message)
})

export function handleError({ error }) {
	console.error('[handleError]', error)
}
