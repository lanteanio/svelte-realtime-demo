/**
 * POST /api/demos/set-org - flip the session's org field.
 *
 * Used by /demos/denials to switch the user between Acme and Globex for
 * the denials demo. The identity lives server-side in Redis keyed by the
 * cookie's session-id; this endpoint mutates the `org` field in place
 * (HSET) without rewriting the cookie. The client reloads after this
 * returns so the next WS handshake reads the updated session.
 *
 * Demo only. A real multi-tenant app would set the org via login flow,
 * not a public POST endpoint.
 */

import { json, error } from '@sveltejs/kit'
import { updateSessionField } from '$lib/server/identity-session'

const VALID_ORGS = new Set(['acme', 'globex'])

export async function POST({ request, url, cookies }) {
	// CSRF defense-in-depth. SvelteKit's built-in CSRF check fires only on
	// form-content-types (application/x-www-form-urlencoded, multipart/form-data,
	// text/plain, and a SvelteKit binary form type). This endpoint accepts
	// application/json, which the framework skips - JSON POSTs are normally
	// protected by the browser's CORS preflight + the identity cookie's
	// `sameSite: lax` attribute. Belt-and-suspenders: also reject any cross-
	// origin Origin header at the application layer so a future cookie-attr
	// regression (or a non-browser client that bypasses CORS) does not open
	// the endpoint up.
	const origin = request.headers.get('origin')
	if (origin && origin !== url.origin) {
		error(403, 'Cross-origin request forbidden')
	}

	const body = await request.json().catch(() => null)
	const org = body?.org
	if (!VALID_ORGS.has(org)) error(400, 'Invalid org')

	const sessionId = cookies.get('identity')
	const ok = await updateSessionField(sessionId, 'org', org)
	if (!ok) {
		error(400, 'No active session - visit a page first to bootstrap one')
	}
	return json({ ok: true, org })
}
