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

// Ensure the stress test board exists on every deploy.
// Safe to call multiple times -- it's a no-op if the board already exists.
ensureBoard({ title: 'stress', slug: 'stress-me-out' }).catch((err) => {
	console.warn('Could not ensure stress test board:', err.message)
})

export function handleError({ error }) {
	console.error('[handleError]', error)
}
