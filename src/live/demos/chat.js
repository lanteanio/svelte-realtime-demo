/**
 * /demos/chat -- rooms + presence + idempotent send + denials banner.
 *
 * The pitch: a focused chat surface that bundles four 0.5.0 ideas on
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
 * Storage is an in-memory Map (demo only -- not durable across server
 * restarts and not shared across instances). Single-server presence
 * is bootstrapped via realtime's _presenceRef fallback (next.5+); a
 * cluster deployment would wire `platform.presence.list` to a Redis
 * registry, same shape.
 */

import { live } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

const MAX_MESSAGES_PER_ROOM = 100

const messages = new Map()

function loadMessages(roomId) {
	return messages.get(roomId) ?? []
}

function pushMessage(roomId, msg) {
	const list = messages.get(roomId) ?? []
	list.push(msg)
	if (list.length > MAX_MESSAGES_PER_ROOM) list.shift()
	messages.set(roomId, list)
}

export const chat = live.room({
	topic: (ctx, roomId) => TOPICS.demoChatRoom(roomId),
	init: async (ctx, roomId) => loadMessages(roomId),
	presence: (ctx) => ({ name: ctx.user.name, color: ctx.user.color })
})

export const sendMessage = live.idempotent(
	{ ttl: 30 },
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
		pushMessage(roomId, msg)
		ctx.publish(TOPICS.demoChatRoom(roomId), 'created', msg)
		return msg
	}
)
