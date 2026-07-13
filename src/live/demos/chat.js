// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/chat - rooms + presence + idempotent send + denials banner.
 *
 * The pitch: a focused chat surface that bundles four ideas on
 * one page.
 *
 * - live.room() declares the room as one export with two sub-streams:
 *   data (the message list) and presence (the user list). One topic
 *   pair, two reactive accessors on the client.
 * - live.idempotent({ ttl }) wraps the sendMessage RPC. A double-tap
 *   on Send or a flaky-reconnect retry with the same idempotencyKey
 *   posts the message once.
 * - The wire-level subscribe denial (configured in src/hooks.ws.js)
 *   for the `private` room surfaces as a typed FORBIDDEN error on
 *   the data stream. The client renders a banner.
 *
 * Replay is intentionally NOT wired on chat: the in-memory store
 * rehydrates on init rerun after reconnect, which is sufficient for
 * a small bounded message list. /demos/counter-resume is the showcase
 * for replay buffer + session resume.
 *
 * Storage is a cluster-shared Redis LIST per room (key:
 * demos:chat:room:{roomId}), capped at MAX_MESSAGES_PER_ROOM via
 * LTRIM. A message sent on one replica is visible to subscribers on
 * every replica via the cluster pub/sub fan-out and via the loader.
 */

import { live } from 'svelte-realtime/server'
import { createIdempotencyStore } from 'svelte-adapter-uws-extensions/redis/idempotency'
import { TOPICS } from '$lib/server/topics'
import { redis, breaker } from '$lib/server/redis'
import { metrics } from '$lib/server/metrics'

const MAX_MESSAGES_PER_ROOM = 100

// Backstop TTL on each room LIST, refreshed on every push. The demo-purge cron
// (src/live/_purge.js) is the primary reaper; this is defense in depth so an
// abandoned room self-expires within a couple of hours even if that cron ever
// regresses again - a room LIST otherwise has no expiry (LTRIM caps size, not
// age), which is exactly how weeks-old chat accumulated in prod.
const CHAT_ROOM_TTL_SEC = 2 * 60 * 60

const roomKey = (roomId) => `demos:chat:room:${roomId}`

/**
 * Cluster-shared idempotency store so a Send-button double-tap that
 * retries on a different replica still posts the message exactly once.
 */
const idempotencyStore = createIdempotencyStore(redis, {
	keyPrefix: 'demos:chat:idemp:',
	ttl: 30,
	acquireTtl: 30,
	breaker,
	metrics
})

async function loadMessages(roomId) {
	const raws = await redis.redis.lrange(roomKey(roomId), 0, -1)
	const out = []
	for (const raw of raws) {
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
	}
	return out
}

/**
 * RPUSH appends newest-last; LTRIM keeps the most recent
 * MAX_MESSAGES_PER_ROOM. LRANGE 0 -(cap+1) captures any messages the
 * subsequent LTRIM is about to drop so subscribers see a 'deleted'
 * event per evicted id rather than a silent disappearance.
 */
async function pushMessage(roomId, msg, ctx) {
	const raw = JSON.stringify(msg)
	const key = roomKey(roomId)
	const pipeline = redis.redis.multi()
	pipeline.rpush(key, raw)
	pipeline.lrange(key, 0, -(MAX_MESSAGES_PER_ROOM + 1))
	pipeline.ltrim(key, -MAX_MESSAGES_PER_ROOM, -1)
	// Refresh the backstop TTL on every push (index 3; the evicted-message read
	// below stays at index 1). An active room keeps resetting its expiry; an
	// abandoned one falls off on its own.
	pipeline.expire(key, CHAT_ROOM_TTL_SEC)
	const results = await pipeline.exec()
	const evicted = /** @type {string[]} */ (results?.[1]?.[1] ?? [])
	for (const evictedRaw of evicted) {
		try {
			const dropped = JSON.parse(evictedRaw)
			ctx.publish(TOPICS.demoChatRoom(roomId), 'deleted', { id: dropped.id })
		} catch { /* corrupt entry already evicted */ }
	}
}

export const chat = live.room({
	topic: (ctx, roomId) => TOPICS.demoChatRoom(roomId),
	init: async (ctx, roomId) => loadMessages(roomId),
	presence: (ctx) => ({ name: ctx.user.name, color: ctx.user.color })
})

/**
 * Wipe every room's message log. SCAN walks the keyspace cluster-wide
 * to find every demos:chat:room:* key; for each, snapshot the contents
 * (so we can publish 'deleted' per message), then DEL the list.
 * Idempotency cache keys for sendMessage retries are NOT touched;
 * their 30s TTL handles itself.
 */
export async function purge(ctx) {
	const keys = []
	let cursor = '0'
	do {
		const [next, batch] = await redis.redis.scan(cursor, 'MATCH', 'demos:chat:room:*', 'COUNT', 100)
		cursor = next
		for (const k of batch) keys.push(k)
	} while (cursor !== '0')

	let messageCount = 0
	for (const key of keys) {
		const roomId = key.slice('demos:chat:room:'.length)
		const raws = await redis.redis.lrange(key, 0, -1)
		await redis.redis.del(key)
		for (const raw of raws) {
			try {
				const msg = JSON.parse(raw)
				ctx.publish(TOPICS.demoChatRoom(roomId), 'deleted', { id: msg.id })
				messageCount++
			} catch { /* corrupt entry already gone */ }
		}
	}
	return { rooms: keys.length, messages: messageCount }
}

export const sendMessage = live.idempotent(
	{ ttl: 30, store: idempotencyStore },
	async (ctx, roomId, text) => {
		const trimmed = String(text ?? '').trim().slice(0, 500)
		if (!trimmed) return null
		const msg = {
			id: crypto.randomUUID(),
			userId: ctx.user.id,
			name: ctx.user.name,
			color: ctx.user.color,
			text: trimmed,
			ts: Date.now()
		}
		await pushMessage(roomId, msg, ctx)
		ctx.publish(TOPICS.demoChatRoom(roomId), 'created', msg)
		return msg
	}
)
