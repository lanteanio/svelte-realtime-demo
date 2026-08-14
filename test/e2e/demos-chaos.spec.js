import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'

const CELL_SELECTOR = '[data-testid^="tick-"]'

async function openChaos(page) {
	await page.goto('/demos/chaos')
	// SSR controls are visible before Svelte has hydrated. Waiting for the
	// realtime status proves client startup completed before any interaction.
	await waitForWS(page)
}

async function setDropRate(page, value) {
	const input = page.getByTestId('drop-rate-input')
	await input.fill(String(value))
	await expect(input).toHaveValue(String(value))
}

async function readCounters(page) {
	const text = (await page.getByTestId('counters').textContent())?.trim() ?? ''
	const match = text.match(/^(\d+)\/(\d+) delivered \((\d+)% empirical drop\)$/)
	expect(match, `unexpected chaos counters: ${text}`).not.toBeNull()
	return {
		deliveredN: Number(match[1]),
		tickN: Number(match[2]),
		dropPercent: Number(match[3])
	}
}

async function waitForTickN(page, minimum) {
	await expect.poll(async () => (await readCounters(page)).tickN, {
		message: `chaos ticker should reach tick ${minimum}`,
		timeout: 8_000
	}).toBeGreaterThanOrEqual(minimum)
}

async function firstPattern(page, count) {
	await waitForTickN(page, count)
	const cells = page.getByTestId('decision-strip').locator(CELL_SELECTOR)
	await expect.poll(() => cells.count(), { timeout: 8_000 }).toBeGreaterThanOrEqual(count)
	return cells.evaluateAll((nodes, size) => nodes.slice(0, size).map((node) => (
		node.getAttribute('data-testid') === 'tick-dropped' ? 'D' : 'K'
	)).join(''), count)
}

async function stopChaos(page) {
	await page.getByTestId('stop-button').click()
	await expect(page.getByTestId('start-button')).toBeVisible()
}

async function pinnedPattern(page, count) {
	const cells = page.getByTestId('previous-strip').locator('[data-testid^="prev-tick-"]')
	await expect.poll(() => cells.count(), { timeout: 8_000 }).toBeGreaterThanOrEqual(count)
	return cells.evaluateAll((nodes, size) => nodes.slice(0, size).map((node) => (
		node.getAttribute('data-testid') === 'prev-tick-dropped' ? 'D' : 'K'
	)).join(''), count)
}

/**
 * A restart republishes the history as an empty set before the first new
 * tick, so a counter read straight after Start can still be the previous
 * run's. Waiting for the count to fall below what the last run reached is
 * what makes the next pattern read belong to the new run.
 */
async function waitForFreshRun(page, priorTickN) {
	if (!priorTickN) return
	await expect.poll(async () => (await readCounters(page)).tickN, {
		message: 'a new run should clear the prior decision history before ticking',
		timeout: 8_000
	}).toBeLessThan(priorTickN)
}

test.describe('/demos/chaos', () => {
	test('every seed/drop control updates the real inputs, including all presets and random seed', async ({ page }) => {
		await openChaos(page)

		for (const preset of [
			{ id: 'preset-1234', seed: '1234', drop: '0.3', label: 'Drop rate (30%)' },
			{ id: 'preset-7777', seed: '7777', drop: '0.5', label: 'Drop rate (50%)' },
			{ id: 'preset-42', seed: '42', drop: '0.1', label: 'Drop rate (10%)' }
		]) {
			await page.getByTestId(preset.id).click()
			await expect(page.getByTestId('seed-input')).toHaveValue(preset.seed)
			await expect(page.getByTestId('drop-rate-input')).toHaveValue(preset.drop)
			await expect(page.getByText(preset.label, { exact: true })).toBeVisible()
		}

		await page.getByTestId('seed-input').fill('-9876')
		await setDropRate(page, 0.63)
		await expect(page.getByText('Drop rate (63%)', { exact: true })).toBeVisible()

		// Every seed this page produces is numeric, so the field asks for the
		// digit keypad rather than the full alphabet.
		await expect(page.getByTestId('seed-input')).toHaveAttribute('inputmode', 'numeric')

		// "random seed" must wear the same chip dress as the presets beside it;
		// borderless, it rendered as plain text and read as unpressable.
		//
		// Two things this deliberately does NOT do. It does not compare border
		// WIDTH: btn-ghost keeps the border box and only paints it transparent,
		// so width is identical either way and would never catch the
		// regression. And it does not compare the two buttons to each other:
		// daisyUI mixes the border colour from --btn-bg, which hover and its
		// 200ms transition both move, so cross-element equality fails for
		// reasons that have nothing to do with the regression. What matters is
		// each button painting a visible edge, so that is what
		// each is asked for on its own.
		const paintsAnEdge = (id) => page.getByTestId(id).evaluate((el) => {
			const style = getComputedStyle(el)
			const transparent = /(?:,|\/)\s*0(?:\.0+)?\)\s*$/.test(style.borderTopColor)
			return Number.parseFloat(style.borderTopWidth) > 0 && !transparent
		})
		expect(await paintsAnEdge('preset-1234'), 'preset chips paint a visible edge').toBe(true)
		expect(await paintsAnEdge('random-seed'), 'random seed must wear the preset chip dress, not a borderless ghost').toBe(true)

		await page.getByTestId('preset-1234').click()
		await page.getByTestId('random-seed').click()
		const random = await page.getByTestId('seed-input').inputValue()
		expect(random).toMatch(/^\d{1,6}$/)
		expect(Number(random)).toBeGreaterThanOrEqual(0)
		expect(Number(random)).toBeLessThan(1_000_000)
	})

	test('invalid seed is rejected without entering a phantom running state', async ({ page }) => {
		await openChaos(page)
		await page.getByTestId('seed-input').fill('not-a-number')
		await page.getByTestId('start-button').click()

		await expect(page.getByTestId('start-button')).toBeVisible()
		await expect(page.getByTestId('start-button')).toBeEnabled()
		await expect(page.getByTestId('stop-button')).toHaveCount(0)
		await expect(page.getByTestId('decision-strip').locator(CELL_SELECTOR)).toHaveCount(0)
		await expect(page.getByText('Click Start to begin.', { exact: true })).toBeVisible()

		// The refusal has to say so: a dead button cannot tell a bad seed apart
		// from a broken demo or a server that is down.
		await expect(page.getByTestId('chaos-action-error')).toContainText('Could not start: Invalid seed')

		// And it must not outlive the condition it reports.
		await page.getByTestId('seed-input').fill('1234')
		await page.getByTestId('start-button').click()
		await expect(page.getByTestId('stop-button')).toBeVisible()
		await expect(page.getByTestId('chaos-action-error')).toHaveCount(0)
		await stopChaos(page)
	})

	test('the decisions header wraps into two whole lines at 320 instead of colliding', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 320, height: 568 } })
		try {
			const page = await context.newPage()
			await openChaos(page)
			const label = await page.getByTestId('decisions-label').boundingBox()
			const counters = await page.getByTestId('counters').boundingBox()
			expect(label, 'decisions label must be visible to measure').not.toBeNull()
			expect(counters, 'counters must be visible to measure').not.toBeNull()
			// As two colliding columns these interleaved into one garbled line;
			// as two wrapping blocks the counters start below the label.
			expect(counters.y).toBeGreaterThanOrEqual(label.y + label.height)
		} finally {
			await context.close()
		}
	})

	test('a stopped run stays pinned so the same seed can be checked cell for cell', async ({ page }) => {
		await openChaos(page)
		await page.getByTestId('seed-input').fill('7777')
		await setDropRate(page, 0.5)
		await page.getByTestId('start-button').click()
		const first = await firstPattern(page, 20)
		let priorTickN = (await readCounters(page)).tickN
		await stopChaos(page)

		// The run the visitor just watched is held, so the next one has
		// something to line up against instead of a memory of 60 cells.
		await expect(page.getByTestId('previous-strip')).toBeVisible()
		await expect(page.getByTestId('previous-caption')).toContainText('seed 7777')
		await expect(page.getByTestId('previous-caption')).toContainText('50% drop rate')
		expect(await pinnedPattern(page, 20)).toBe(first)

		await page.getByTestId('start-button').click()
		await expect(page.getByTestId('compare-hint')).toContainText('paint identically')
		await waitForFreshRun(page, priorTickN)
		expect(await firstPattern(page, 20)).toBe(first)
		expect(await pinnedPattern(page, 20)).toBe(first)
		priorTickN = (await readCounters(page)).tickN
		await stopChaos(page)

		await page.getByTestId('seed-input').fill('42')
		await page.getByTestId('start-button').click()
		await expect(page.getByTestId('compare-hint')).toContainText('diverge')
		await waitForFreshRun(page, priorTickN)
		const different = await firstPattern(page, 20)
		expect(different).not.toBe(first)
		// The pinned row is still the seed-7777 run it was captured from,
		// which is what makes the divergence readable against it.
		expect(await pinnedPattern(page, 20)).toBe(first)

		await stopChaos(page)
		await expect(page.getByTestId('previous-caption')).toContainText('seed 42')
	})

	test('0% run locks controls, keeps every decision, reports exact counters, and really stops', async ({ page }) => {
		await openChaos(page)
		await page.getByTestId('preset-42').click()
		await setDropRate(page, 0)
		await page.getByTestId('start-button').click()

		await expect(page.getByTestId('stop-button')).toBeVisible()
		for (const id of ['seed-input', 'drop-rate-input', 'preset-1234', 'preset-7777', 'preset-42', 'random-seed']) {
			await expect(page.getByTestId(id)).toBeDisabled()
		}

		const pattern = await firstPattern(page, 12)
		expect(pattern).toBe('K'.repeat(12))
		const counters = await readCounters(page)
		expect(counters.deliveredN).toBe(counters.tickN)
		expect(counters.dropPercent).toBe(0)

		await stopChaos(page)
		await expect(page.getByTestId('seed-input')).toBeEnabled()
		await expect(page.getByTestId('drop-rate-input')).toBeEnabled()
		await page.waitForTimeout(250)
		const stoppedAt = (await readCounters(page)).tickN
		await page.waitForTimeout(500)
		expect((await readCounters(page)).tickN).toBe(stoppedAt)
	})

	test('100% run drops every decision and reports zero delivered', async ({ page }) => {
		await openChaos(page)
		await page.getByTestId('seed-input').fill('7777')
		await setDropRate(page, 1)
		await page.getByTestId('start-button').click()

		const pattern = await firstPattern(page, 12)
		expect(pattern).toBe('D'.repeat(12))
		const counters = await readCounters(page)
		expect(counters.deliveredN).toBe(0)
		expect(counters.dropPercent).toBe(100)
		await stopChaos(page)
	})

	test('same seed and drop rate replay exactly; a different seed changes the sequence', async ({ page }) => {
		await openChaos(page)
		let priorTickN = 0

		async function run(seed, dropRate, count = 24) {
			await page.getByTestId('seed-input').fill(String(seed))
			await setDropRate(page, dropRate)
			await page.getByTestId('start-button').click()
			if (priorTickN > 0) {
				await expect.poll(async () => (await readCounters(page)).tickN, {
					message: 'a new run should clear the prior decision history before ticking',
					timeout: 8_000
				}).toBeLessThan(priorTickN)
			}
			const pattern = await firstPattern(page, count)
			priorTickN = (await readCounters(page)).tickN
			await stopChaos(page)
			return pattern
		}

		const first = await run(7777, 0.5)
		const replay = await run(7777, 0.5)
		const different = await run(42, 0.5)

		expect(replay).toBe(first)
		expect(different).not.toBe(first)
		expect(first).toContain('D')
		expect(first).toContain('K')
	})

	test('refresh closes the active session and leaves no orphan ticker running', async ({ page }) => {
		await openChaos(page)
		await page.getByTestId('preset-7777').click()
		await page.getByTestId('start-button').click()
		await waitForTickN(page, 8)

		await page.reload()
		await waitForWS(page)
		await expect(page.getByTestId('start-button')).toBeVisible()
		await expect(page.getByTestId('stop-button')).toHaveCount(0)
		await expect(page.getByTestId('seed-input')).toBeEnabled()
		await expect(page.getByTestId('decision-strip').locator(CELL_SELECTOR)).toHaveCount(0)
		await page.waitForTimeout(600)
		expect((await readCounters(page)).tickN).toBe(0)
	})

	test('two tabs for one user receive the same ordered decisions and stop together at the producer', async ({ browser }) => {
		const context = await browser.newContext()
		const first = await context.newPage()
		const second = await context.newPage()
		try {
			await openChaos(first)
			await openChaos(second)
			await first.getByTestId('preset-7777').click()
			await first.getByTestId('start-button').click()

			const [firstPatternValue, secondPatternValue] = await Promise.all([
				firstPattern(first, 16),
				firstPattern(second, 16)
			])
			expect(secondPatternValue).toBe(firstPatternValue)

			await stopChaos(first)
			await pageTicksToSettle(first, second)
		} finally {
			await context.close()
		}
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await openChaos(page)
			for (const id of ['preset-1234', 'preset-7777', 'preset-42', 'random-seed']) {
				await expectTouchTarget(page.getByTestId(id))
			}
			await expectTouchTarget(page.getByTestId('seed-input'))
			await expectTouchTarget(page.getByTestId('start-button'))
			await expectTouchTarget(page.getByTestId('drop-rate-input'), { minWidth: 0 })
		} finally {
			await context.close()
		}
	})
})

async function pageTicksToSettle(...pages) {
	await pages[0].waitForTimeout(250)
	const stopped = await Promise.all(pages.map(async (page) => (await readCounters(page)).tickN))
	await pages[0].waitForTimeout(500)
	const later = await Promise.all(pages.map(async (page) => (await readCounters(page)).tickN))
	expect(later).toEqual(stopped)
}
