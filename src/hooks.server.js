/**
 * SvelteKit server-side hooks.
 *
 * handleError: catches unhandled errors during SSR and API routes.
 *
 * Database migrations are an explicit pre-traffic deployment step. Runtime
 * startup only ensures well-known application data exists (like the stress
 * test board used by the E2E suite), and the request hook awaits that work.
 */

import { ensureBoard } from '$lib/server/db'
import { live } from 'svelte-realtime/server'
import { env } from '$env/dynamic/private'
import { deploymentHosts, isAcceptableHost } from '$lib/server/origin-policy'

/**
 * Every hostname this deployment answers to, read once at startup. Empty for
 * a checkout that declares none, which leaves the Host check inert so a fresh
 * clone serves normally with no configuration.
 */
const acceptedHosts = deploymentHosts(env)

// Dev-mode safety net: warn once if a stream subscribes to a topic and
// no events arrive within 30 seconds. Catches "I forgot ctx.publish"
// and "the SQL trigger never fired" classes of bug at the framework
// level. Production-stripped via NODE_ENV gate inside the helper.
live.silentTopicWarning({ thresholdMs: 30_000 })

let applicationReady = null
let applicationInitialized = false

function initializeApplicationData() {
	if (!applicationReady) {
		const pending = ensureBoard({ title: 'stress', slug: 'stress-me-out' })
			.then((value) => {
				applicationInitialized = true
				return value
			})
			.catch((error) => {
				// A dependency outage must fail this request, not poison the worker
				// forever with a cached rejected promise. The next request retries.
				if (applicationReady === pending) applicationReady = null
				throw error
			})
		applicationReady = pending
	}
	return applicationReady
}

export async function handle({ event, resolve }) {
	// The readiness route reports dependency health itself and must answer even
	// when Postgres is down; gating it here would turn its structured 503 into
	// an opaque 500. Let it (and its sub-paths) through untouched.
	if (event.url.pathname === '/healthz' || event.url.pathname.startsWith('/healthz/')) {
		return resolve(event)
	}
	const hostHeader = event.request.headers.get('host')
	if (!isAcceptableHost(hostHeader, acceptedHosts)) {
		console.warn(
			`[host-check] refused host=${hostHeader ?? '(absent)'}` +
			` path=${event.url.pathname} ip=${event.getClientAddress()}`
		)
		return new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain' } })
	}
	// Steady state: the one-time init promise is already resolved, so skip the
	// await entirely. If the schema migration was skipped or Postgres is
	// unavailable, fail closed instead of serving a partially initialized app.
	if (!applicationInitialized) {
		await initializeApplicationData()
	}
	const response = await resolve(event)
	// Only the framing directive. A full policy would have to enumerate every
	// script, style and connect source the demo pages use, and getting that
	// wrong breaks the app; this one directive stands on its own and is the
	// piece that stops the pages being embedded under another name.
	response.headers.set('content-security-policy', "frame-ancestors 'self'")
	return response
}

export function handleError({ error }) {
	console.error('[handleError]', error)
}
