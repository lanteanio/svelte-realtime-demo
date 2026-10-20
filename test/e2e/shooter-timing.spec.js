import { test, expect } from '@playwright/test'
import { openShooter, shootRenderedTarget } from './shooter-helpers.js'

function observeShots(page) {
	const shots = []
	page.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
		let frame
		try { frame = JSON.parse(String(payload)) } catch { return }
		if (frame.rpc === 'demos/shooter/shooter/__smooth/shoot') {
			shots.push({ sentAt: Date.now(), payload: frame.args.at(-1) })
		}
	}))
	return shots
}

test('delayed shots retain click-time stamps through the public transport', async ({ page }) => {
	const shots = observeShots(page)
	await openShooter(page)
	for (const delay of [300, 600]) {
		const count = shots.length
		await page.getByTestId('sh-lag').fill(String(delay))
		await shootRenderedTarget(page)
		await expect.poll(() => shots.length).toBe(count + 1)
		const shot = shots.at(-1)
		expect(Number.isFinite(shot.payload.rt)).toBe(true)
		const age = shot.sentAt - shot.payload.rt
		expect(age, `wire age after holding a shot ${delay}ms`).toBeGreaterThan(delay - 100)
		expect(age, `wire age after holding a shot ${delay}ms`).toBeLessThan(delay + 250)
	}
})

test('the latency slider can request a rewind far beyond the server ceiling', async ({ page }) => {
	const shots = observeShots(page)
	await openShooter(page)
	const slider = page.getByTestId('sh-lag')
	await expect(slider).toHaveAttribute('max', '2000')
	await expect(page.getByTestId('sh-lag-cap-mark')).toHaveText('400 = cap')
	await expect(page.getByTestId('sh-lag-cap-mark')).toHaveAttribute('style', /left:\s*20%/)
	await slider.fill('2000')
	await shootRenderedTarget(page)
	await expect.poll(() => shots.length).toBe(1)
	const shot = shots[0]
	expect(shot.sentAt - shot.payload.rt).toBeGreaterThan(1900)
})
