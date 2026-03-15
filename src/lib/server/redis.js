import { createRedisClient } from 'svelte-adapter-uws-extensions/redis'
import { createPubSubBus } from 'svelte-adapter-uws-extensions/redis/pubsub'
import { createRateLimit } from 'svelte-adapter-uws-extensions/redis/ratelimit'
import { createPresence } from 'svelte-adapter-uws-extensions/redis/presence'
import { createCursor } from 'svelte-adapter-uws-extensions/redis/cursor'
import { env } from '$env/dynamic/private'

export const redis = createRedisClient({ url: env.REDIS_URL })
export const bus = createPubSubBus(redis)
export const limiter = createRateLimit(redis, { points: 100, interval: 10000 })

export const presence = createPresence(redis, {
	key: 'id',
	heartbeat: 30000,
	select: (u) => ({ id: u.id, name: u.name, color: u.color })
})

export const cursor = createCursor(redis, {
	throttle: 50,
	topicThrottle: 16,
	select: (u) => ({ id: u.id, name: u.name, color: u.color })
})
