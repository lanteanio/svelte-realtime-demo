import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'
import { watchArena, location, panTo } from './arena-wire.js'

const configured = [process.env.BASE_URL, process.env.INSTANCE_B, process.env.INSTANCE_C, process.env.INSTANCE_D]
const origins = configured.filter(Boolean).map((raw) => {
	const url = assertSafeE2ETarget(raw)
	if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Arena replica targets must use HTTP or HTTPS')
	return url.origin
})
const requested = process.env.E2E_CLUSTER_REPLICAS === '4' || Boolean(process.env.INSTANCE_C || process.env.INSTANCE_D)
test.skip(!requested, 'four-replica arena coverage requires E2E_CLUSTER_REPLICAS=4 or explicit INSTANCE_C/D')

function remote(page, key) {
	return page.locator(`[data-testid="arena-minimap-entity"][data-key="${key}"]`)
}

test('four replicas explicitly remove and reacquire the same visitors as interest moves', async ({ browser }) => {
	test.setTimeout(120_000)
	expect(origins.length, 'requested four-replica coverage requires BASE_URL and INSTANCE_B/C/D').toBe(4)
	expect(new Set(origins).size, 'each observer must connect to a distinct replica origin').toBe(4)
	const contexts = []
	const visitors = []
	try {
		for (const origin of origins) {
			const context = await browser.newContext({ baseURL: origin })
			contexts.push(context)
			const page = await context.newPage()
			const wire = watchArena(page)
			await page.goto('/demos/arena')
			await waitForWS(page)
			await expect.poll(() => wire.ownKey, { message: `arena sync missing on ${origin}` }).toMatch(/^[\w:-]+$/)
			await expect(page.getByTestId('arena-me')).toBeVisible()
			visitors.push({ page, wire, origin })
		}
		expect(new Set(visitors.map(({ wire }) => wire.ownKey)).size, 'each participant must have its own identity').toBe(4)
		// Give every visitor an authoritative update before testing cull exits.
		// Idle-newcomer delivery is a separate regression; this test starts with
		// a known included entity and cannot pass because it was absent all along.
		for (const visitor of visitors) {
			const before = await location(visitor.page, 'visitor')
			await visitor.page.keyboard.down(before.x > 1200 ? 'ArrowLeft' : 'ArrowRight')
			try {
				await expect.poll(async () => (await location(visitor.page, 'visitor')).x).not.toBe(before.x)
			} finally {
				await visitor.page.keyboard.up(before.x > 1200 ? 'ArrowLeft' : 'ArrowRight')
			}
			await visitor.page.getByTestId('arena-spectate-toggle').check()
			visitor.spot = await location(visitor.page, 'visitor')
		}
		for (let i = 0; i < visitors.length; i++) {
			const observer = visitors[i]
			const target = visitors[(i + 1) % visitors.length]
			await panTo(observer.page, target.spot)
			await expect.poll(() => observer.wire.updates.get(target.wire.ownKey) ?? 0, { message: 'peer must enter ongoing interest delivery before leaving it' }).toBeGreaterThan(0)
			expect(observer.wire.binaryFrames, 'the production binary path must be observed').toBeGreaterThan(0)
			await expect(remote(observer.page, target.wire.ownKey), `${observer.origin} must first include the peer`).toHaveCount(1)
			for (let lap = 0; lap < 3; lap++) {
				const key = target.wire.ownKey
				const npcKeys = (await observer.page.locator('[data-testid="arena-minimap-entity"][data-kind="npc"]').evaluateAll((dots) => dots.map((dot) => dot.getAttribute('data-key')))).filter((npc) => observer.wire.updates.has(npc))
				expect(npcKeys.length, 'the camera must also include server-driven NPCs').toBeGreaterThan(0)
				const npcRemoves = new Map(npcKeys.map((npc) => [npc, observer.wire.removes.get(npc) ?? 0]))
				const removed = observer.wire.removes.get(key) ?? 0
				await panTo(observer.page, { x: target.spot.x > 1200 ? 0 : 2400, y: target.spot.y })
				await expect.poll(() => observer.wire.removes.get(key) ?? 0, {
					message: `${observer.origin}: lap ${lap + 1} needs an explicit peer remove, not TTL expiry`, timeout: 5_000
				}).toBeGreaterThan(removed)
				await expect(remote(observer.page, key)).toHaveCount(0)
				await expect.poll(() => npcKeys.filter((npc) => (observer.wire.removes.get(npc) ?? 0) > npcRemoves.get(npc)).length, { message: 'panning must explicitly release traversed NPCs too' }).toBeGreaterThan(0)
				const received = observer.wire.updates.get(key) ?? 0
				await panTo(observer.page, target.spot)
				await expect.poll(() => observer.wire.updates.get(key) ?? 0, {
					message: `${observer.origin}: peer must be delivered again after interest returns`, timeout: 5_000
				}).toBeGreaterThan(received)
				await expect(remote(observer.page, key)).toHaveCount(1)
				await expect(observer.page.getByTestId('arena-me')).toBeVisible()
				expect(observer.wire.removes.get(observer.wire.ownKey) ?? 0, 'spectating must never evict the observer itself').toBe(0)
			}
			await panTo(observer.page, { x: 1200, y: 800 })
			// A radius-420 circle covers about 14% of this 150-NPC world.
			// Allow ample room for drift; half the catalog still retained is
			// evidence that traversed or initially unculled entities linger.
			let settledCount
			await expect.configure({ soft: true }).poll(async () => {
				const match = ((await observer.page.getByTestId('arena-hud').textContent()) ?? '').match(/receiving\s+(\d+)\s+of\s+(\d+)/)
				settledCount = match ? Number(match[1]) : NaN
				return settledCount
			}, { message: 'traversed NPCs must not accumulate toward the full 150-entity catalog', timeout: 5_000 }).toBeLessThan(80)
			expect(observer.wire.decodeErrors, 'every mapped smooth binary frame must decode').toBe(0)
			console.log(`arena interest exit/re-entry verified: ${observer.origin}, 3 laps; join snapshot ${observer.wire.snapshotSize}, settled received ${settledCount}`)
		}
		for (const { wire } of visitors) expect(wire.decodeErrors, 'all observer decoders remain synchronized').toBe(0)
	} finally {
		await Promise.allSettled(contexts.map((context) => context.close()))
	}
})
