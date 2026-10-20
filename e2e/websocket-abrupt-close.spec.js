import { test, expect } from '@playwright/test'
import { WebSocket } from 'ws'
import { resolveE2EBaseURL, toWebSocketURL, toHandshakeOrigin } from '../scripts/test-target.mjs'

// Presence joins await Redis. A socket that closes inside that gap makes the
// join reject with WS_CLOSED after the close hook has already cleaned up, and
// the hooks must absorb that rejection instead of letting it end the process.
// Sockets here close at staggered points right after the open hook (global
// presence join) and right after a board subscribe (board presence join).

const SOCKETS_PER_INSTANCE = 240
const CONCURRENCY = 24

function targets() {
	const urls = [resolveE2EBaseURL()]
	if (process.env.INSTANCE_B) urls.push(process.env.INSTANCE_B)
	return urls
}

// Resolves true once the socket has opened and then closed, false when the
// handshake fails before opening.
function dropSocket(wsURL, index) {
	return new Promise((resolve, reject) => {
		let opened = false
		const ws = new WebSocket(wsURL, { headers: { Origin: toHandshakeOrigin(wsURL) } })
		const timer = setTimeout(() => { ws.terminate(); reject(new Error('socket did not close')) }, 15_000)
		ws.on('open', () => {
			opened = true
			const delay = index % 6
			if (index % 2 === 0) {
				ws.send(JSON.stringify({ type: 'subscribe', topic: `board:${crypto.randomUUID()}:notes` }))
			}
			const drop = () => (index % 3 === 0 ? ws.terminate() : ws.close())
			if (delay === 0) drop()
			else setTimeout(drop, delay)
		})
		ws.on('close', () => { clearTimeout(timer); resolve(opened) })
		ws.on('error', () => { /* a refused or terminated socket reports an error before close */ })
	})
}

async function hammer(wsURL) {
	let next = 0
	let opened = 0
	async function lane() {
		while (next < SOCKETS_PER_INSTANCE) {
			if (await dropSocket(wsURL, next++)) opened++
		}
	}
	await Promise.all(Array.from({ length: CONCURRENCY }, lane))
	return opened
}

// Resolves once the server acknowledges a subscribe sent on a fresh socket.
function subscribeAck(wsURL) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsURL, { headers: { Origin: toHandshakeOrigin(wsURL) } })
		const timer = setTimeout(() => { ws.terminate(); reject(new Error('no subscribed ack')) }, 10_000)
		ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', topic: 'boards', ref: 1 })))
		ws.on('message', (data) => {
			let frame
			try { frame = JSON.parse(String(data)) } catch { return }
			if (frame?.type !== 'subscribed' || frame.ref !== 1) return
			clearTimeout(timer)
			ws.close()
			resolve(frame.topic)
		})
		ws.on('error', (error) => { clearTimeout(timer); reject(error) })
	})
}

test.describe('WebSocket abrupt close', () => {
	test.setTimeout(120_000)

	test('server survives sockets that close while presence is joining', async ({ request }, testInfo) => {
		// Opens hundreds of sockets against each server, so it runs only in the
		// serial isolated project of the local runner.
		expect(testInfo.project.name).toBe('isolated')
		expect(process.env.LOCAL_E2E).toBe('1')

		const urls = targets()
		for (const url of urls) {
			const response = await request.get(new URL('/board/stress-me-out', url).href)
			expect(response.status()).toBe(200)
		}

		const opened = await Promise.all(urls.map((url) => hammer(toWebSocketURL(url))))
		expect(opened, 'every socket completed its handshake').toEqual(urls.map(() => SOCKETS_PER_INSTANCE))
		// Pending presence joins settle after their Redis replies; wait 1.5 s
		// before checking the servers.
		await new Promise((resolve) => setTimeout(resolve, 1500))

		for (const url of urls) {
			const response = await request.get(new URL('/board/stress-me-out', url).href)
			expect(response.status(), `${url} still serves pages`).toBe(200)
			expect(await subscribeAck(toWebSocketURL(url)), `${url} still acknowledges subscribes`).toBe('boards')
		}
	})
})
