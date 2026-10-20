import { test, expect } from '@playwright/test'
import { boardCanvas, createFreshBoard, expectOnline } from './board-helpers.js'
import { switchTenant, waitForWsConfirmed } from './tenants-helpers.js'

async function observeConnections(page) {
	const connections = []
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		const server = socket.connectToServer()
		const record = { sequence: 0, requests: [], replies: [], pluginFrames: [], legacy: [], held: [], holdReply: false, rejectNext: false, rejections: 0, release: () => {}, close: () => {
			socket.close({ code: 1012, reason: 'test reconnect' })
			server.close()
		} }
		connections.push(record)
		function decode(payload) {
			let frame
			try { frame = JSON.parse(String(payload)) } catch { return [] }
			const values = []
			function visit(value) {
				if (!value || typeof value !== 'object') return
				if (Array.isArray(value)) { value.forEach(visit); return }
				values.push(value)
				if (value.batch) visit(value.batch)
				if (value.events) visit(value.events)
				if (value.topic === '__rpc') visit(value.data)
			}
			visit(frame)
			return values
		}
		function isReply(value) { return value.ok === true && record.requests.some((request) => request.id === value.id) }
		function read(payload, direction) {
			const sequence = ++record.sequence
			for (const value of decode(payload)) {
				if (direction === 'out') {
					if (value.rpc === 'boards/cursors/participateBoard') record.requests.push({ ...value, sequence, at: Date.now() })
					if (['boards/cursors/joinBoard', 'boards/cursors/leaveBoard'].includes(value.rpc)) record.legacy.push(value.rpc)
					if (['cursor', 'cursor-snapshot', 'presence-snapshot'].includes(value.type)) record.pluginFrames.push({ ...value, sequence })
				} else if (isReply(value)) {
					record.replies.push({ ...value, sequence })
				}
			}
		}
		record.release = () => {
			record.holdReply = false
			for (const payload of record.held.splice(0)) { read(payload, 'in'); socket.send(payload) }
		}
		socket.onMessage((payload) => {
			read(payload, 'out')
			const request = decode(payload).find((value) => value.rpc === 'boards/cursors/participateBoard')
			if (record.rejectNext && request) {
				record.rejectNext = false
				record.rejections += 1
				// Reject before forwarding so the real server never grants this
				// attempt. Keep unrelated requests in a shared batch intact.
				const frame = JSON.parse(String(payload))
				if (frame.batch) {
					frame.batch = frame.batch.filter((item) => item.id !== request.id)
					if (frame.batch.length) server.send(JSON.stringify(frame))
				}
				socket.send(JSON.stringify({ topic: '__rpc', event: request.id, data: { id: request.id, ok: false, code: 'OVERLOADED', error: 'Staged participation admission limit' } }))
				return
			}
			server.send(payload)
		})
		server.onMessage((payload) => {
			if (record.holdReply && decode(payload).some(isReply)) { record.held.push(payload); return }
			read(payload, 'in')
			socket.send(payload)
		})
	})
	return connections
}

async function assertReady(page, connection, expectedReplies, expectedRequests = expectedReplies) {
	await expect.poll(() => connection.replies.length).toBe(expectedReplies)
	expect(connection.requests).toHaveLength(expectedRequests)
	expect(connection.legacy).toEqual([])
	const reply = connection.replies.at(-1)
	const request = connection.requests.find((item) => item.id === reply.id)
	const topic = `@t/acme/board:${request.args[0]}`
	expect(reply.data.topic).toBe(topic)
	await expectOnline(page, 1)
	const canvas = await boardCanvas(page).boundingBox()
	if (!canvas) throw new Error('board canvas has no bounding box')
	await page.mouse.move(canvas.x + 180, canvas.y + 160)
	await expect.poll(() => connection.pluginFrames.filter((frame) => frame.type === 'cursor' && frame.topic === topic).length).toBeGreaterThan(0)
	expect(connection.pluginFrames.filter((frame) => frame.topic.startsWith('board:'))).toEqual([])
	// A home-card observer may already have permission to request presence.
	// Cursor access belongs to participation and must follow its reply.
	for (const type of ['cursor-snapshot', 'cursor']) {
		const frames = connection.pluginFrames.filter((frame) => frame.type === type && frame.topic === topic && frame.sequence > request.sequence)
		expect(frames.length, `${type} uses the acknowledged canonical topic`).toBeGreaterThan(0)
		for (const frame of frames) expect(frame.sequence, `${type} waits for managed acknowledgment`).toBeGreaterThan(reply.sequence)
	}
	return topic
}

async function navigateWithinApp(page, path) {
	await page.evaluate((target) => {
		document.querySelector('[data-testid="managed-board-switch"]')?.remove()
		const link = document.createElement('a')
		link.href = target
		link.textContent = 'Switch board'
		link.dataset.testid = 'managed-board-switch'
		document.body.append(link)
	}, path)
	await page.getByTestId('managed-board-switch').click()
	await expect(page).toHaveURL(new RegExp(`${path}$`))
}

test('board participation gates scoped plugins through route changes and reconnect', async ({ page }) => {
	test.setTimeout(90_000)
	const connections = await observeConnections(page)
	await page.goto('/demos/tenants')
	await waitForWsConfirmed(page)
	await switchTenant(page, 'acme')
	const firstPath = await createFreshBoard(page, `Managed first ${Date.now()}`)
	const first = connections.at(-1)
	// The unchanged client calls the legacy RPC and opens raw board topics.
	expect(first.legacy).toEqual([])
	await assertReady(page, first, 1)
	const secondPath = await createFreshBoard(page, `Managed second ${Date.now()}`)
	const second = connections.at(-1)
	const secondTopic = await assertReady(page, second, 1)
	// A normal same-origin link exercises SvelteKit's existing page instance
	// receiving new route data, rather than replacing the whole document.
	await navigateWithinApp(page, firstPath)
	expect(firstPath).not.toBe(secondPath)
	expect(connections.at(-1)).toBe(second)
	const firstTopic = await assertReady(page, second, 2)
	expect(firstTopic).not.toBe(secondTopic)
	const previousConnections = connections.length
	second.close()
	await expect.poll(() => connections.length).toBeGreaterThan(previousConnections)
	const reconnected = connections.at(-1)
	expect(await assertReady(page, reconnected, 1)).toBe(firstTopic)
	reconnected.rejectNext = true
	await navigateWithinApp(page, secondPath)
	await expect.poll(() => reconnected.rejections).toBe(1)
	expect(await assertReady(page, reconnected, 2, 3)).toBe(secondTopic)
	const [rejected, retry] = reconnected.requests.slice(-2)
	expect(retry.at - rejected.at).toBeGreaterThanOrEqual(750)
	expect(retry.args[1]).toBe(rejected.args[1] + 1)
	// Hold the next real managed response: while the server has attached,
	// the page has no acknowledged topic. Leaving must not open late stores.
	reconnected.holdReply = true
	await navigateWithinApp(page, firstPath)
	await expect.poll(() => reconnected.held.length).toBe(1)
	const pending = reconnected.requests.at(-1)
	const box = await boardCanvas(page).boundingBox()
	if (!box) throw new Error('pending board canvas has no bounding box')
	await page.mouse.move(box.x + 220, box.y + 190)
	expect(reconnected.pluginFrames.filter((frame) => frame.topic === firstTopic && frame.sequence > pending.sequence)).toEqual([])
	await navigateWithinApp(page, '/demos/tenants')
	reconnected.release()
	await waitForWsConfirmed(page)
	await expect.poll(() => reconnected.replies.length).toBe(3)
	await expect(page.getByTestId('tn-active-tenant')).toHaveText('acme')
	// Proxy receipt precedes browser delivery. Let the browser process the
	// released frame and flush Svelte effects before checking for late stores.
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
	expect(reconnected.pluginFrames.filter((frame) => frame.topic === firstTopic && frame.sequence > pending.sequence)).toEqual([])
})
