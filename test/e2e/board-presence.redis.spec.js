import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { connect } from 'svelte-adapter-uws/client'
import { createTestServer } from 'svelte-adapter-uws/testing'
import { createRedisClient } from 'svelte-adapter-uws-extensions/redis'
import { createPresence } from 'svelte-adapter-uws-extensions/redis/presence'
import { createCursor } from 'svelte-adapter-uws-extensions/redis/cursor'
import { createRateLimit } from 'svelte-adapter-uws-extensions/redis/ratelimit'
import { createMessage, realtime } from 'svelte-realtime/server'
import { createTestEnv } from 'svelte-realtime/testing'
import { boardStreams, boardHooks, boardBeforeExecute, BOARD_ID } from '../helpers/board-observer.js'

test.skip(process.env.LOCAL_E2E !== '1', 'requires the local harness Redis')

test('a full board list preserves the real Redis action budget', async () => {
	const raw = process.env.REDIS_URL
	if (!raw || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(raw).hostname)) throw new Error('loopback Redis required')
	const redis = createRedisClient({ url: raw, autoShutdown: false })
	const userId = `test-board-budget-${randomUUID()}`
	const limiter = createRateLimit(redis, { points: 100, interval: 10000, keyBy: () => userId })
	const beforeExecute = boardBeforeExecute(limiter)
	try {
		for (let index = 0; index < 100; index++) await beforeExecute({}, 'boards/cursors/observeBoard')
		await beforeExecute({}, 'boards/cursors/participateBoard')
		await beforeExecute({}, 'boards/createBoard')
		// Exactly 99 actions remain; only the lifecycle transport was exempt.
		for (let index = 0; index < 99; index++) await beforeExecute({}, 'boards/notes/createNote')
		await expect(beforeExecute({}, 'boards/notes/createNote')).rejects.toMatchObject({ code: 'RATE_LIMITED' })
	} finally { await redis.quit() }
})

for (const tenant of [null, 'acme']) {
	for (const first of ['observer', 'participant']) {
		test(`real ${tenant ?? 'public'} board roles survive ${first} unsubscribe independently`, async () => {
			const raw = process.env.REDIS_URL
			if (!raw || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(raw).hostname)) {
				throw new Error('this test requires loopback Redis')
			}
			const prefix = `test:board-roles:${randomUUID()}:`
			const redis = createRedisClient({ url: raw, autoShutdown: false })
			const presence = createPresence(redis, { prefix, key: 'id', heartbeat: 30000, select: (user) => ({ id: user.id }) })
			const cursor = createCursor(redis, { prefix, select: (user) => ({ id: user.id }) })
			const env = createTestEnv()
			const hooks = boardHooks(presence, cursor, (user) => user?.tenant ?? null)
			env.register('boards', boardStreams(presence, cursor, async (id) => id === BOARD_ID ? { board_id: id } : null))
			const server = await createTestServer({
				authorizeWireSubscribe: 'strict',
				handler: {
					...hooks,
					upgrade: () => ({ id: 'visitor', tenant }),
					message: createMessage()
				}
			})
			const connection = connect({ url: server.wsUrl, auth: false })
			const frames = []
			const stopEvents = connection.events.subscribe((frame) => { if (frame) frames.push(frame) })
			let connectionStatus
			const stopStatus = connection.status.subscribe((value) => { connectionStatus = value })
			const stops = []
			try {
				await expect.poll(() => connectionStatus).toBe('open')
				const ready = {}
				for (const role of ['observer', 'participant']) {
					const id = `role-${role}`
					connection.send({ rpc: `boards/${role === 'observer' ? 'observeBoard' : 'participateBoard'}`, id, args: [BOARD_ID], stream: true, attach: true })
					await expect.poll(() => frames.find((frame) => frame.event === id && frame.data?.ok)).toBeTruthy()
					const response = frames.find((frame) => frame.event === id && frame.data?.ok).data
					// Real adapter stores own and coalesce the client topic references.
					const stop = connection.on(response.topic).subscribe(() => {})
					stops.push(stop)
					ready[role] = { ...response, stop }
					if (role === 'observer') expect(await presence.list(response.data.topic)).toEqual([])
				}
				const topic = ready.observer.data.topic
				expect(ready.participant.data.topic).toBe(topic)
				expect(topic).toBe(`${tenant ? '@t/acme/' : ''}board:${BOARD_ID}`)
				expect(await presence.list(topic)).toEqual([{ id: 'visitor' }])
				const ws = [...server.wsConnections][0]
				ready[first].stop()
				const last = first === 'observer' ? 'participant' : 'observer'
				await expect.poll(() => ws.isSubscribed(ready[first].topic)).toBe(false)
				expect(ws.isSubscribed(ready[last].topic)).toBe(true)
				expect(ws.isSubscribed(topic)).toBe(true)
				expect(ws.isSubscribed(`__presence:${topic}`)).toBe(true)
				await expect.poll(() => presence.list(topic)).toEqual(first === 'observer' ? [{ id: 'visitor' }] : [])
				// The surviving observer receives a fresh roster after the participant leaves.
				if (last === 'observer') {
					await presence.sync(ws, topic, server.platform)
					await expect.poll(() => frames.filter((frame) => frame.topic === `__presence:${topic}` && frame.event === 'state').at(-1)?.data).toEqual({})
				}
				ready[last].stop()
				await expect.poll(() => ws.isSubscribed(topic)).toBe(false)
				expect(ws.isSubscribed(`__presence:${topic}`)).toBe(false)
				expect(await presence.list(topic)).toEqual([])
			} finally {
				for (const stop of stops) stop()
				stopEvents(); stopStatus(); connection.close()
				await server.close()
				await presence.destroy()
				await cursor.destroy()
				env.cleanup()
				realtime({ tenant: null })
				const keys = await redis.redis.keys(`${prefix}*`)
				if (keys.length) await redis.redis.del(...keys)
				await redis.quit()
			}
		})
	}
}

for (const role of ['observer', 'participant']) {
	test(`socket close drains an in-flight ${role} attachment through the app hooks`, async () => {
		const raw = process.env.REDIS_URL
		if (!raw || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(raw).hostname)) throw new Error('loopback Redis required')
		const prefix = `test:board-close:${randomUUID()}:`
		const redis = createRedisClient({ url: raw, autoShutdown: false })
		const presence = createPresence(redis, { prefix, key: 'id', select: (user) => ({ id: user.id }) })
		const cursor = createCursor(redis, { prefix, select: (user) => ({ id: user.id }) })
		let release = () => {}
		const gate = new Promise((resolve) => { release = () => resolve(undefined) })
		let parked = false
		const plugin = role === 'observer' ? presence : cursor
		const method = role === 'observer' ? 'sync' : 'attach'
		const original = plugin[method]
		plugin[method] = async (...args) => {
			await original(...args)
			parked = true
			await gate
		}
		const env = createTestEnv()
		const hooks = boardHooks(presence, cursor, (user) => user?.tenant ?? null)
		env.register('boards', boardStreams(presence, cursor, async () => ({ board_id: BOARD_ID })))
		const server = await createTestServer({ authorizeWireSubscribe: 'strict', handler: {
			...hooks, upgrade: () => ({ id: 'closing', tenant: 'acme' }), message: createMessage()
		} })
		const revoked = []
		const unsubscribe = server.platform.unsubscribe.bind(server.platform)
		server.platform.unsubscribe = (ws, topic) => { revoked.push(topic); return unsubscribe(ws, topic) }
		const connection = connect({ url: server.wsUrl, auth: false })
		let connectionStatus
		const stop = connection.status.subscribe((value) => { connectionStatus = value })
		try {
			await expect.poll(() => connectionStatus).toBe('open')
			connection.send({ rpc: `boards/${role === 'observer' ? 'observeBoard' : 'participateBoard'}`, id: 'closing', args: [BOARD_ID], stream: true })
			await expect.poll(() => parked).toBe(true)
			const topic = `@t/acme/board:${BOARD_ID}`
			const ws = [...server.wsConnections][0]
			expect(ws.isSubscribed(topic)).toBe(true)
			expect(await presence.list(topic)).toEqual(role === 'participant' ? [{ id: 'closing' }] : [])
			connection.close()
			await expect.poll(() => server.wsConnections.size).toBe(0)
			expect(revoked).not.toContain(topic)
			release()
			// Native socket teardown alone removes subscriptions. This call also
			// proves the managed role drain waited for the in-flight attach.
			await expect.poll(() => revoked.includes(topic)).toBe(true)
			await expect.poll(() => presence.list(topic)).toEqual([])
			await expect.poll(() => server.platform.subscribers(topic)).toBe(0)
			await expect.poll(() => server.platform.subscribers(`__presence:${topic}`)).toBe(0)
		} finally {
			release(); stop(); connection.close()
			await server.close()
			await presence.destroy(); await cursor.destroy()
			env.cleanup(); realtime({ tenant: null })
			const keys = await redis.redis.keys(`${prefix}*`)
			if (keys.length) await redis.redis.del(...keys)
			await redis.quit()
		}
	})
}
