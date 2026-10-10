import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

const CASES = [
	{ name: 'topk speed', path: '/demos/topk', topic: 'demos:topk:control:speed', field: 'speed', input: 'speed-input', initial: 7, older: 11, newer: 29, reset: 5 },
	{ name: 'topk bias', path: '/demos/topk', topic: 'demos:topk:control:bias', field: 'bias', initial: 'hot', older: 'monopoly', newer: 'uniform', reset: 'uniform' },
	{ name: 'news speed', path: '/demos/news', topic: 'demos:news:control', field: 'speed', input: 'news-speed-input', initial: 7, older: 11, newer: 29, reset: 5 }
]

export function controlOrderingTests({ cluster = false } = {}) {
	for (const item of CASES) {
		test(item.name + ' keeps the newer write when same-frame publishes arrive backwards', async ({ browser, baseURL }) => {
			test.setTimeout(90_000)
			const originA = baseURL
			const originB = cluster ? process.env.INSTANCE_B : baseURL
			const contexts = []
			let a
			const act = async (page, value) => {
				if (item.input) await page.getByTestId(item.input).fill(String(value), { timeout: 8000 })
				else await page.getByTestId('bias-' + value).click({ timeout: 8000 })
			}
			const check = async (page, value) => {
				if (item.input) await expect(page.getByTestId(item.input)).toHaveValue(String(value), { timeout: 10000 })
				else await expect(page.getByTestId('bias-' + value)).toHaveClass(/btn-primary/, { timeout: 10000 })
			}
			let armed = false
			let held = null
			let released = false
			let forwarded = 0
			try {
				for (const origin of [originA, originB, originB]) contexts.push(await browser.newContext({ baseURL: origin }))
				a = await contexts[0].newPage()
				const b = await contexts[1].newPage()
				const w = await contexts[2].newPage()
				await w.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					const server = ws.connectToServer()
					ws.onMessage((message) => server.send(message))
					server.onMessage((message) => {
						let frame
						try { frame = typeof message === 'string' ? JSON.parse(message) : null } catch {}
						const events = frame?.type === 'batch' && Array.isArray(frame.events) ? frame.events : [frame]
						if (!events.some((event) => event?.topic === item.topic)) return ws.send(message)
						const others = events.filter((event) => event?.topic !== item.topic)
						if (others.length) ws.send(JSON.stringify({ ...frame, events: others }))
						for (const event of events.filter((event) => event?.topic === item.topic)) {
							if (armed && !held && event.data?.[item.field] === item.older) { held = event; continue }
							if (held && !released && event.data?.[item.field] === item.newer) {
								// One frame forces set-merge to expose only the older payload.
								ws.send(JSON.stringify({ type: 'batch', events: [event, held] }))
								forwarded += 2
								released = true
							} else {
								ws.send(JSON.stringify(event))
								forwarded++
							}
						}
					})
				})
				await w.addInitScript((topic) => {
					const Base = window.WebSocket
					window.__orderedControlFrames = 0
					window.WebSocket = class extends Base {
						constructor(...args) {
							super(...args)
							this.addEventListener('message', (message) => {
								try {
									const frame = JSON.parse(message.data)
									const events = frame?.type === 'batch' ? frame.events : [frame]
									window.__orderedControlFrames += events.filter((event) => event?.topic === topic).length
								} catch {}
							})
						}
					}
				}, item.topic)
				for (const page of [a, b, w]) { await page.goto(item.path); await waitForWS(page) }
				await act(a, item.initial)
				await check(w, item.initial)
				await check(b, item.initial)
				armed = true
				await act(a, item.older)
				await expect.poll(() => held !== null, { timeout: 10000 }).toBe(true)
				await act(b, item.newer)
				await expect.poll(() => released, { timeout: 10000 }).toBe(true)
				await expect.poll(() => w.evaluate(() => window.__orderedControlFrames), { timeout: 10000 }).toBe(forwarded)
				await w.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
				await check(w, item.newer)
				await check(a, item.newer)
				await check(b, item.newer)
				await w.reload()
				await waitForWS(w)
				await check(w, item.newer)
			} finally {
				if (a && !a.isClosed()) await act(a, item.reset).catch(() => {})
				await Promise.all(contexts.map((context) => context.close()))
			}
		})
	}
}
