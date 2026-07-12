/**
 * POST /api/demos/set-tenant - flip or clear the session's tenant field.
 *
 * Used by /demos/tenants to opt the user into strict per-connection
 * tenant isolation (Acme or Globex) or back out of it. The identity
 * lives server-side in Redis keyed by the cookie's session-id; this
 * endpoint mutates the `tenant` field in place without rewriting the
 * cookie. The client reloads after this returns because the tenant
 * resolver runs per-connection at WebSocket upgrade - the next
 * handshake reads the updated session.
 *
 * Clearing: the session store writes strings only, so `tenant: null`
 * is persisted as the empty string; the session validator maps any
 * value outside the allowed set back to null on read.
 *
 * Demo only. A real multi-tenant app would derive the tenant from the
 * login flow, not a public POST endpoint.
 */

import { json, error } from '@sveltejs/kit'
import { updateSessionField } from '$lib/server/identity-session'

const VALID_TENANTS = new Set(['acme', 'globex'])

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
	if (!body || typeof body !== 'object' || !('tenant' in body)) {
		error(400, 'Invalid tenant')
	}
	const tenant = body.tenant
	if (tenant !== null && !VALID_TENANTS.has(tenant)) error(400, 'Invalid tenant')

	const sessionId = cookies.get('identity')
	const ok = await updateSessionField(sessionId, 'tenant', tenant ?? '')
	if (!ok) {
		error(400, 'No active session - visit a page first to bootstrap one')
	}
	return json({ ok: true, tenant })
}
