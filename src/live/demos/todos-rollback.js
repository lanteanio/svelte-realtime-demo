/**
 * /demos/todos-rollback -- optimistic mutate with concurrent-failure rollback.
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
 * Storage: in-memory array (demo only -- not durable across restart, not
 * shared across instances).
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

const MAX_TODOS = 200

const todos = []

export const todosStream = live.stream(TOPICS.demoTodos, async () => todos.slice(), {
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
	if (todos.length >= MAX_TODOS) throw new LiveError('FULL', 'Todos list full')
	const todo = { id, text: trimmed, done: false, ts: Date.now() }
	todos.push(todo)
	ctx.publish(TOPICS.demoTodos, 'created', todo)
	return todo
})

export const toggleTodo = live(async (ctx, { id, forceFail }) => {
	if (forceFail) throw new LiveError('FORCED', 'Force-fail is on')
	const todo = todos.find((t) => t.id === id)
	if (!todo) throw new LiveError('NOT_FOUND', 'Todo not found')
	todo.done = !todo.done
	ctx.publish(TOPICS.demoTodos, 'updated', todo)
	return todo
})

export const removeTodo = live(async (ctx, { id, forceFail }) => {
	if (forceFail) throw new LiveError('FORCED', 'Force-fail is on')
	const idx = todos.findIndex((t) => t.id === id)
	if (idx === -1) throw new LiveError('NOT_FOUND', 'Todo not found')
	const removed = todos.splice(idx, 1)[0]
	ctx.publish(TOPICS.demoTodos, 'deleted', removed)
	return removed
})

export const clearAll = live(async (ctx) => {
	const snapshot = todos.slice()
	todos.length = 0
	for (const t of snapshot) {
		ctx.publish(TOPICS.demoTodos, 'deleted', t)
	}
	return { cleared: snapshot.length }
})
