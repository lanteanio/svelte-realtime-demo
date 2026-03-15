/**
 * SvelteKit server-side error handler.
 * Catches unhandled errors during SSR and API routes.
 * In production you'd send these to an error tracking service.
 */
export function handleError({ error }) {
	console.error('[handleError]', error)
}
