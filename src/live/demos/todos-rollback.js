// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/todos-rollback - optimistic mutate with concurrent-failure rollback.
 *
 * The pitch: rapid mutates apply optimistically and roll back independently
 * when the server says no. With `forceFail` flipped on, every add / toggle /
 * remove rejects with `LiveError('FORCED', ...)`; each optimistic placeholder
 * disappears cleanly with no phantom traces, even when several are in flight.
 *
 * Mechanism:
 * - `rpc.createOptimistic(store, [args], change)` from realtime ties the
 *   optimistic UI update to the RPC call. On reject, the change rolls back.
 * - The client supplies the todo's `id` (UUID), so the server's confirming
 *   `created` event matches the placeholder by key (crud merge).
 * - `forceFail` is a per-call flag, NOT server-side state. Each user's tab
 *   has its own toggle; concurrent users don't fight over it.
 *
 * Storage: cluster-shared Redis HASH keyed by todo id. A todo added on one
 * replica is visible to subscribers on every replica (via the HSET + cluster
 * pub/sub fan-out of the 'created' event).
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { redis } from '$lib/server/redis'

const MAX_TODOS = 200
const TODOS_KEY = 'demos:todos'

async function listTodos() {
	const raws = await redis.redis.hvals(TODOS_KEY)
	const out = []
	for (const raw of raws) {
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
	}
	return out
}

export const todosStream = live.stream(TOPICS.demoTodos, async () => listTodos(), {
	merge: 'crud',
	key: 'id'
})

export const addTodo = live(async (ctx, { id, text, forceFail }) => {
	if (forceFail) throw new LiveError('FORCED', 'Force-fail is on')
	const trimmed = String(text ?? '').trim().slice(0, 200)
	if (!trimmed) throw new LiveError('VALIDATION', 'Todo text required')
	if (typeof id !== 'string' || id.length < 1 || id.length > 64) {
		throw new LiveError('VALIDATION', 'Invalid id')
	}
	const len = await redis.redis.hlen(TODOS_KEY)
	if (len >= MAX_TODOS) throw new LiveError('FULL', 'Todos list full')
	const todo = { id, text: trimmed, done: false, ts: Date.now() }
	await redis.redis.hset(TODOS_KEY, id, JSON.stringify(todo))
	ctx.publish(TOPICS.demoTodos, 'created', todo)
	return todo
})

export const toggleTodo = live(async (ctx, { id, forceFail }) => {
	if (forceFail) throw new LiveError('FORCED', 'Force-fail is on')
	const raw = await redis.redis.hget(TODOS_KEY, id)
	if (!raw) throw new LiveError('NOT_FOUND', 'Todo not found')
	let todo
	try { todo = JSON.parse(raw) } catch { throw new LiveError('NOT_FOUND', 'Todo not found') }
	todo.done = !todo.done
	await redis.redis.hset(TODOS_KEY, id, JSON.stringify(todo))
	ctx.publish(TOPICS.demoTodos, 'updated', todo)
	return todo
})

export const removeTodo = live(async (ctx, { id, forceFail }) => {
	if (forceFail) throw new LiveError('FORCED', 'Force-fail is on')
	const raw = await redis.redis.hget(TODOS_KEY, id)
	if (!raw) throw new LiveError('NOT_FOUND', 'Todo not found')
	let todo
	try { todo = JSON.parse(raw) } catch { throw new LiveError('NOT_FOUND', 'Todo not found') }
	const removed = await redis.redis.hdel(TODOS_KEY, id)
	if (removed === 0) throw new LiveError('NOT_FOUND', 'Todo not found')
	ctx.publish(TOPICS.demoTodos, 'deleted', todo)
	return todo
})

/**
 * Wipe the todos hash. Snapshot before delete so we can publish a
 * 'deleted' event per id; a concurrent addTodo that lands between the
 * HVALS and the DEL is harmless (its 'created' is what subscribers
 * see; the next clear catches it).
 */
export async function purge(ctx) {
	const raws = await redis.redis.hvals(TODOS_KEY)
	await redis.redis.del(TODOS_KEY)
	for (const raw of raws) {
		try {
			const t = JSON.parse(raw)
			ctx.publish(TOPICS.demoTodos, 'deleted', t)
		} catch { /* corrupt entry already gone */ }
	}
	return { todos: raws.length }
}

export const clearAll = live(async (ctx) => {
	const result = await purge(ctx)
	return { cleared: result.todos }
})
