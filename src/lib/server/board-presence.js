import { LiveError } from 'svelte-realtime/server'

// Match the app-owned suffix, including a framework-scoped wire topic. The
// framework remains responsible for deciding and granting the tenant scope.
const BOARD_PRESENCE_TOPIC_RE = /(?:^|\/)board:[0-9a-f-]+(?::observer|:participant)?$/i

export function usesExplicitBoardPresenceLifecycle(topic) {
	return typeof topic === 'string' && BOARD_PRESENCE_TOPIC_RE.test(topic)
}

/** Independent managed roles sharing one explicitly authorized roster topic. */
export function createBoardPresenceLifecycle({ presence, cursor }) {
	const sockets = new WeakMap()
	const results = new WeakMap()

	function canonicalTopic(resolvedTopic, role) {
		const suffix = `:${role}`
		if (!resolvedTopic.endsWith(suffix) || !usesExplicitBoardPresenceLifecycle(resolvedTopic)) {
			throw new LiveError('FORBIDDEN', 'Invalid board role topic')
		}
		// Remove only our role suffix from the trusted lifecycle-hook topic.
		return resolvedTopic.slice(0, -suffix.length)
	}

	function enqueue(ctx, topic, operation) {
		let topics = sockets.get(ctx.ws)
		if (!topics) { topics = new Map(); sockets.set(ctx.ws, topics) }
		let state = topics.get(topic)
		if (!state) {
			state = {
				queue: Promise.resolve(), pending: 0, granted: false,
				observer: 0, participant: 0, observing: false, joined: false, participating: false
			}
			topics.set(topic, state)
		}
		state.pending++
		const queued = state.queue.then(() => operation(state))
		// An attach failure must not prevent its queued rollback from running.
		state.queue = queued.catch(() => {}).finally(() => {
			state.pending--
			if (!state.pending && !state.observer && !state.participant) {
				topics.delete(topic)
				if (!topics.size) sockets.delete(ctx.ws)
			}
		})
		return queued
	}

	return {
		async attach(ctx, resolvedTopic, role) {
			const topic = canonicalTopic(resolvedTopic, role)
			const result = { topic, error: null }
			results.set(ctx, result)
			try {
				await enqueue(ctx, topic, async (state) => {
					state[role]++
					if (!state.granted) {
						const denial = await ctx.platform.subscribe(ctx.ws, topic)
						if (denial) throw new LiveError(denial, 'Board access was refused')
						state.granted = true
					}
					if (role === 'observer' && !state.observing) {
						const denial = await presence.sync(ctx.ws, topic, ctx.platform)
						if (denial) throw new LiveError(denial, 'Board observation was refused')
						state.observing = true
					} else if (role === 'participant' && !state.participating) {
						if (!state.joined) {
							await presence.join(ctx.ws, topic, ctx.platform)
							state.joined = true
						}
						await cursor.attach(ctx.ws, topic, ctx.platform)
						state.participating = true
					}
				})
			} catch (error) {
				result.error = error instanceof LiveError ? error : new LiveError(
					error?.code === 'SUBSCRIBE_DENIED' ? 'FORBIDDEN' : 'REALTIME_UNAVAILABLE',
					'Board presence is temporarily unavailable'
				)
			}
		},
		load(ctx) {
			const result = results.get(ctx)
			results.delete(ctx)
			if (!result) throw new LiveError('REALTIME_UNAVAILABLE', 'Board presence did not initialize')
			// Lifecycle exceptions alone are best-effort in the framework. Reject
			// the loader so a failed attach also rolls back its managed grant.
			if (result.error) throw result.error
			return { topic: result.topic }
		},
		detach(ctx, resolvedTopic, role) {
			const topic = canonicalTopic(resolvedTopic, role)
			return enqueue(ctx, topic, async (state) => {
				if (!state[role]) return
				state[role]--
				try {
					if (role === 'observer' && !state.observer) {
						await presence.hooks.unsubscribe(ctx.ws, `__presence:${topic}`, { platform: ctx.platform })
						state.observing = false
					} else if (role === 'participant' && !state.participant) {
						// leave() removes the observer if no participant exists, so
						// only call it after a successful join, including partial attach.
						const cleanup = []
						if (state.joined) cleanup.push(presence.leave(ctx.ws, ctx.platform, topic))
						cursor.detach(ctx.ws, topic, ctx.platform)
						cleanup.push(cursor.remove(ctx.ws, ctx.platform, topic))
						const settled = await Promise.allSettled(cleanup)
						state.joined = state.participating = false
						const failed = settled.find((item) => item.status === 'rejected')
						if (failed?.status === 'rejected') throw failed.reason
					}
				} finally {
					if (!state.observer && !state.participant && state.granted) {
						ctx.platform.unsubscribe(ctx.ws, topic)
						state.granted = false
					}
				}
			})
		}
	}
}
