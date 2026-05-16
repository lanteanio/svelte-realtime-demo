/**
 * Layout server load - runs on every page request.
 *
 * Manages the user's identity via a session cookie. The cookie carries
 * only a 128-bit opaque session-id; the identity itself lives in Redis
 * under `identity-session:<id>`. See $lib/server/identity-session for
 * the storage contract.
 *
 * The cookie is NOT httpOnly because the client-side JS needs to read
 * it (the WebSocket upgrade handler in hooks.ws.js also reads it). The
 * cookie value itself is not sensitive - it is a lookup key into the
 * server-side store, not the identity itself.
 */

import { dev } from '$app/environment'
import {
	lookupSession,
	createSession,
	tryParseLegacyJsonCookie,
	SESSION_COOKIE_MAX_AGE
} from '$lib/server/identity-session'

const COOKIE_OPTS = {
	path: '/',
	httpOnly: false,
	secure: !dev,
	sameSite: 'lax',
	maxAge: SESSION_COOKIE_MAX_AGE
}

export async function load({ cookies }) {
	const raw = cookies.get('identity')

	// Fast path: cookie holds a valid session-id and the session exists.
	const existing = await lookupSession(raw)
	if (existing) return { identity: existing }

	// Migration path: legacy plain-JSON cookies from before this change.
	// Mint a session populated with the legacy values so the visitor
	// keeps their displayed name across the upgrade. Runs at most once
	// per pre-existing visitor; after the first hit they have a real
	// session and follow the fast path.
	const legacy = tryParseLegacyJsonCookie(raw)
	const { sessionId, identity } = await createSession(legacy)
	cookies.set('identity', sessionId, COOKIE_OPTS)
	return { identity }
}
