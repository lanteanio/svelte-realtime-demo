/**
 * POST /api/demos/set-org -- rewrite the identity cookie's org field.
 *
 * Used by /demos/denials to switch the user between Acme and Globex
 * for the denials demo. The cookie is the source of truth for
 * `ws.userData.org` (set in src/hooks.ws.js upgrade hook), so the
 * client reloads after this returns to pick up the new org on the
 * next WS handshake.
 *
 * Demo only. A real multi-tenant app would set the org via login
 * flow, not a public POST endpoint.
 */

import { json, error } from '@sveltejs/kit'

const VALID_ORGS = new Set(['acme', 'globex'])

export async function POST({ request, cookies }) {
	const body = await request.json().catch(() => null)
	const org = body?.org
	if (!VALID_ORGS.has(org)) error(400, 'Invalid org')

	const existing = cookies.get('identity')
	let identity
	try {
		identity = existing ? JSON.parse(existing) : null
	} catch {
		identity = null
	}
	if (!identity || typeof identity !== 'object') {
		error(400, 'No identity cookie -- visit a page first to bootstrap one')
	}

	identity.org = org
	cookies.set('identity', JSON.stringify(identity), {
		path: '/',
		sameSite: 'lax',
		maxAge: 60 * 60 * 24 * 30
	})
	return json({ ok: true, org })
}
