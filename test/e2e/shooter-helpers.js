import { expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

export function collectShooterErrors(page) {
	const errors = []
	page.on('pageerror', (err) => errors.push(`pageerror: ${err?.message ?? err}`))
	page.on('console', (msg) => {
		if (msg.type() === 'error' && !/Failed to load resource|favicon/i.test(msg.text())) {
			errors.push(`console: ${msg.text()}`)
		}
	})
	return errors
}

export async function openShooter(page, url = '/demos/shooter') {
	await page.goto(url)
	await waitForWS(page)
	await expect(page.getByTestId('sh-me')).toBeVisible({ timeout: 15_000 })
	await expect.poll(() => page.getByTestId('sh-target').count(), { timeout: 15_000 }).toBe(8)
}

export async function clickRangeAt(page, vx, vy) {
	const box = await page.getByTestId('sh-range').boundingBox()
	if (!box) throw new Error('shooter range is not visible')
	await page.mouse.click(
		box.x + (vx / 640) * box.width,
		box.y + (vy / 420) * box.height
	)
}

export async function shootRenderedTarget(page, target = page.getByTestId('sh-target').first()) {
	const cx = Number(await target.getAttribute('cx'))
	const cy = Number(await target.getAttribute('cy'))
	expect(Number.isFinite(cx) && Number.isFinite(cy)).toBe(true)
	await clickRangeAt(page, cx, cy)
}

function numberFrom(text) {
	return Number(text?.match(/\d+/)?.[0] ?? 0)
}

export async function shooterStats(page) {
	const [score, shots, hits] = await Promise.all([
		page.getByTestId('sh-score').textContent(),
		page.getByTestId('sh-shots').textContent(),
		page.getByTestId('sh-hits').textContent()
	])
	return { score: numberFrom(score), shots: numberFrom(shots), hits: numberFrom(hits) }
}

export async function ownPosition(page) {
	const me = page.getByTestId('sh-me')
	return {
		x: Number(await me.getAttribute('data-x')),
		y: Number(await me.getAttribute('data-y'))
	}
}

export async function holdKey(page, key, duration = 400) {
	await page.keyboard.down(key)
	await page.waitForTimeout(duration)
	await page.keyboard.up(key)
}

export async function closestRemote(page, position) {
	await expect.poll(() => page.getByTestId('sh-other').count(), { timeout: 10_000 }).toBeGreaterThan(0)
	const remotes = await page.getByTestId('sh-other').evaluateAll((nodes) => nodes.map((node) => ({
		key: node.getAttribute('data-key') ?? '',
		x: Number(node.getAttribute('cx')),
		y: Number(node.getAttribute('cy'))
	})))
	return remotes.reduce((closest, remote) => {
		const distance = Math.hypot(remote.x - position.x, remote.y - position.y)
		return !closest || distance < closest.distance ? { ...remote, distance } : closest
	}, null)
}

export function remoteByKey(page, key) {
	return page.locator(`[data-testid="sh-other"][data-key="${key}"]`)
}
