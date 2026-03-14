import { generateIdentity } from '$lib/names'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

function parseIdentity(raw) {
	if (!raw) return null
	try {
		const obj = JSON.parse(raw)
		if (
			!obj || typeof obj !== 'object' ||
			typeof obj.id !== 'string' || !UUID_RE.test(obj.id) ||
			typeof obj.name !== 'string' || obj.name.length < 1 || obj.name.length > 40 ||
			typeof obj.color !== 'string' || !HEX_COLOR_RE.test(obj.color)
		) {
			return null
		}
		return { id: obj.id, name: obj.name, color: obj.color }
	} catch {
		return null
	}
}

export function load({ cookies }) {
	const existing = parseIdentity(cookies.get('identity'))
	if (existing) return { identity: existing }

	const identity = { id: crypto.randomUUID(), ...generateIdentity() }
	cookies.set('identity', JSON.stringify(identity), { path: '/', httpOnly: false, maxAge: 60 * 60 * 24 * 365 })
	return { identity }
}
