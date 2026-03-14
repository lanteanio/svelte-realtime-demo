import { createMessage, LiveError } from 'svelte-realtime/server'
import { createRedisClient, createPubSubBus, createRateLimit, createPresence, createCursor } from 'svelte-adapter-uws-extensions/redis'
import { generateIdentity } from '$lib/names'

const redis = createRedisClient({ url: process.env.REDIS_URL })
const bus = createPubSubBus(redis)
const limiter = createRateLimit(redis, { points: 20, interval: 10000 })

export const presence = createPresence(redis, {
	key: 'id',
	select: (u) => ({ id: u.id, name: u.name, color: u.color })
})

export const cursor = createCursor(redis, {
	throttle: 50,
	select: (u) => ({ id: u.id, name: u.name, color: u.color })
})

export function upgrade({ cookies }) {
	const existing = cookies.identity
	if (existing) {
		try {
			return JSON.parse(existing)
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
}

export function close(ws, { platform }) {
	presence.leave(ws, platform)
	cursor.remove(ws, platform)
}

export const message = createMessage({
	platform: (p) => bus.wrap(p),
	async beforeExecute(ws, rpcPath) {
		const { allowed, resetMs } = await limiter.consume(ws)
		if (!allowed) throw new LiveError('RATE_LIMITED', `Retry in ${Math.ceil(resetMs / 1000)}s`)
	}
})
