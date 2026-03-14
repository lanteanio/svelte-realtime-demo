import { createMessage, LiveError } from 'svelte-realtime/server'
import { bus, limiter, presence, cursor } from '$lib/server/redis'
import { generateIdentity } from '$lib/names'

export { presence, cursor }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

function validateIdentity(obj) {
	if (!obj || typeof obj !== 'object') return null
	if (typeof obj.id !== 'string' || !UUID_RE.test(obj.id)) return null
	if (typeof obj.name !== 'string' || obj.name.length < 1 || obj.name.length > 40) return null
	if (typeof obj.color !== 'string' || !HEX_COLOR_RE.test(obj.color)) return null
	return { id: obj.id, name: obj.name, color: obj.color }
}

export function upgrade({ cookies }) {
	const existing = cookies.identity
	if (existing) {
		try {
			const parsed = validateIdentity(JSON.parse(existing))
			if (parsed) return parsed
		} catch {}
	}

	const identity = {
		id: crypto.randomUUID(),
		...generateIdentity()
	}

	cookies.identity = JSON.stringify(identity)
	return identity
}

export function open(ws, { platform }) {
	bus.activate(platform)
	presence.join(ws, 'global', platform)
}

export function subscribe(ws, topic, ctx) {
	presence.hooks.subscribe(ws, topic, ctx)
}

export function close(ws, { platform }) {
	presence.hooks.close(ws, { platform })
	cursor.remove(ws, platform)
}

const THROTTLED_RPCS = new Set(['boards/notes/moveNote', 'boards/cursors/moveCursor', 'boards/cursors/joinBoard'])

export const message = createMessage({
	platform: (p) => bus.wrap(p),
	async beforeExecute(ws, rpcPath) {
		if (THROTTLED_RPCS.has(rpcPath)) return
		const { allowed, resetMs } = await limiter.consume(ws)
		if (!allowed) throw new LiveError('RATE_LIMITED', `Retry in ${Math.ceil(resetMs / 1000)}s`)
	}
})
