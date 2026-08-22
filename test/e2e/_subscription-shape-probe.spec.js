// Ground truth for the subscription half of the wire.
//
// The connection probe in helpers.js proves a socket opened. It says nothing
// about what the page then ASKED for, which is the whole of the gap when a
// content wait times out behind a green connection indicator. This probe reads
// the frames from the Playwright side and prints them classified, so the shape
// of a real subscribe/reply/deliver exchange is a recorded fact rather than a
// reading of the adapter's source.

import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

function describe(frame) {
	const raw = frame.payload
	if (typeof raw !== 'string') return `${frame.dir} <binary ${raw.length}b>`
	let parsed = null
	try { parsed = JSON.parse(raw) } catch { return `${frame.dir} <non-json ${raw.slice(0, 24)}>` }
	if (parsed.rpc) return `${frame.dir} rpc=${parsed.rpc} stream=${parsed.stream === true}`
	if (Array.isArray(parsed.batch)) return `${frame.dir} batch[${parsed.batch.length}] ${parsed.batch.map((b) => b.rpc).join(',')}`
	if (parsed.type) return `${frame.dir} type=${parsed.type} topic=${parsed.topic ?? '-'}`
	if (parsed.topic) return `${frame.dir} topic=${parsed.topic} event=${parsed.event ?? '-'}`
	return `${frame.dir} ${raw.slice(0, 40)}`
}

function report(label, frames) {
	console.log(`=== ${label}: ${frames.length} frames`)
	const kinds = new Map()
	for (const frame of frames) {
		const key = describe(frame)
		kinds.set(key, (kinds.get(key) ?? 0) + 1)
	}
	for (const [key, count] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${String(count).padStart(4)} x ${key}`)
	}
}

function verbatim(label, frames, limit = 12) {
	console.log(`=== ${label} verbatim (first ${limit}, 300 chars)`)
	for (const frame of frames.slice(0, limit)) {
		const raw = typeof frame.payload === 'string' ? frame.payload : `<binary ${frame.payload.length}b>`
		console.log(`  ${frame.dir} ${raw.slice(0, 300)}`)
	}
}

function watch(page) {
	const frames = []
	page.on('websocket', (ws) => {
		const url = ws.url()
		ws.on('framesent', (f) => frames.push({ dir: 'out', url, payload: f.payload }))
		ws.on('framereceived', (f) => frames.push({ dir: 'in', url, payload: f.payload }))
	})
	return frames
}

test('wire shape: flash-sales, boot then a live mutation', async ({ page }) => {
	test.setTimeout(120_000)
	const frames = watch(page)

	await page.goto('/demos/flash-sales')
	await waitForWS(page)
	await expect(page.getByTestId('product-card-phone')).toBeVisible({ timeout: 30_000 })
	await page.waitForTimeout(1500)
	report('boot', frames)
	verbatim('boot', frames, 20)

	// A mutation is the only way to see what a LIVE delivery looks like: the
	// boot burst carries the stream's initial payload over __rpc, which is a
	// different frame from the update that follows a write.
	const boot = frames.length
	const buy = page.getByTestId('product-buy-phone')
	if (await buy.count()) {
		await buy.click()
		await page.waitForTimeout(3000)
		report('after buy', frames.slice(boot))
		verbatim('after buy', frames.slice(boot), 12)
	} else {
		console.log('=== no product-buy-phone control; test ids present:')
		console.log(await page.locator('[data-testid]').evaluateAll((els) => els.map((e) => e.dataset.testid).slice(0, 40)))
	}
})

test('wire shape: a board', async ({ page }) => {
	test.setTimeout(120_000)
	const frames = watch(page)

	await page.goto('/')
	await waitForWS(page)
	await page.getByPlaceholder('New board name...').fill(`Wire shape ${Date.now()}`)
	await page.getByRole('button', { name: 'Create', exact: true }).click()
	await page.waitForURL(/\/board\//, { timeout: 15_000 })
	const boot = frames.length
	await page.locator('div.relative.w-full.overflow-auto').waitFor({ state: 'visible', timeout: 30_000 })
	await page.waitForTimeout(1500)
	report('board open', frames.slice(boot))
	verbatim('board open', frames.slice(boot), 20)
})

test('wire shape: privacy, boot then a submission', async ({ page }) => {
	test.setTimeout(120_000)
	const frames = watch(page)

	await page.goto('/demos/privacy')
	await waitForWS(page)
	await expect(page.getByTestId('pv-picker-section')).toBeVisible({ timeout: 30_000 })
	await page.waitForTimeout(1500)
	report('privacy boot', frames)
	verbatim('privacy boot', frames, 16)

	const boot = frames.length
	await page.getByTestId('pv-submit-2').click()
	await page.waitForTimeout(4000)
	report('privacy after submit', frames.slice(boot))
	verbatim('privacy after submit', frames.slice(boot), 12)
})
