import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

// Single-page assertions. The lounge is one shared global room, so the
// tests avoid exact roster counts (parallel visitors are legal) and
// assert the local surfaces instead: room.others EXCLUDES self once
// identified, so the roster check targets the self badge, not a count.
test.describe('/demos/multiplayer', () => {
	test('page loads with canvas, roster, typing indicator, and reaction bar', async ({ page }) => {
		await page.goto('/demos/multiplayer')
		await waitForWS(page)

		await expect(page.getByTestId('mp-canvas')).toBeVisible()
		await expect(page.getByTestId('mp-roster')).toBeVisible()
		await expect(page.getByTestId('mp-roster')).toContainText('(you)')
		await expect(page.getByTestId('mp-typing')).toBeVisible()
		await expect(page.getByTestId('mp-lock-state')).toBeVisible()
		for (const token of ['heart', 'fire', 'clap', 'star']) {
			await expect(page.getByTestId(`mp-react-${token}`)).toBeVisible()
		}
	})

	test('headline input takes the advisory lock on focus and sets the headline', async ({ page }) => {
		await page.goto('/demos/multiplayer')
		await waitForWS(page)

		const input = page.getByTestId('mp-headline-input')
		await expect(input).toBeEnabled({ timeout: 10_000 })

		// Focus acquires the 'headline' lock; the stamp round-trips through
		// the presence roster before the lock-state line flips.
		await input.focus()
		await expect(page.getByTestId('mp-lock-state')).toHaveText('You hold the lock.', { timeout: 5_000 })

		const text = `e2e headline ${Date.now()}`
		await input.fill(text)
		await page.getByTestId('mp-headline-submit').click()
		await expect(page.getByTestId('mp-headline-display')).toHaveText(text, { timeout: 5_000 })
		await expect(page.getByTestId('mp-error')).toHaveCount(0)

		// Blur releases the lock again.
		await input.blur()
		await expect(page.getByTestId('mp-lock-state')).toHaveText('Lock free.', { timeout: 5_000 })
	})

	test('pointer movement over the canvas renders the local cursor', async ({ page }) => {
		await page.goto('/demos/multiplayer')
		await waitForWS(page)

		const canvas = page.getByTestId('mp-canvas')
		const box = await canvas.boundingBox()
		// A few distinct positions so at least one volatile send lands
		// after the subscription is live.
		for (const [fx, fy] of [[0.3, 0.3], [0.5, 0.5], [0.7, 0.6]]) {
			await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 5 })
			await page.waitForTimeout(150)
		}

		// room.cursors keeps self, so the local dot must appear once the
		// move round-trips through the cursor stream.
		await expect(page.getByTestId('mp-cursor').first()).toBeVisible({ timeout: 5_000 })
	})

	test('reaction tap emits a floating emote without throwing', async ({ page }) => {
		await page.goto('/demos/multiplayer')
		await waitForWS(page)

		await page.getByTestId('mp-react-heart').click()

		// The emote rides the reactions stream back onto the canvas.
		await expect(page.getByTestId('mp-reaction').first()).toBeAttached({ timeout: 5_000 })
		await expect(page.getByTestId('mp-error')).toHaveCount(0)
	})

	// A second reaction must NOT disturb emotes already floating. The failure
	// this guards: rendering the reaction ring keyed by object identity re-keys
	// every entry on each push, so Svelte tears down and rebuilds all reaction
	// nodes, restarting the float animation (existing emotes snap back to spawn,
	// faded ones revive). We assert the first emote's animation keeps advancing
	// across a second, different reaction instead of rewinding toward zero.
	test('a second reaction does not restart earlier reactions animations', async ({ page }) => {
		await page.goto('/demos/multiplayer')
		await waitForWS(page)

		// Progress of the heart emote's float animation, or null if its node is
		// missing. currentTime rewinding toward zero means the node was recreated.
		const heartProgress = () => page.evaluate(() => {
			const nodes = [...document.querySelectorAll('[data-testid="mp-reaction"]')]
			const heart = nodes.find((n) => n.textContent.includes('❤'))
			const anim = heart && heart.getAnimations ? heart.getAnimations()[0] : null
			return anim ? Number(anim.currentTime) : null
		})

		await page.getByTestId('mp-react-heart').click()
		await expect(page.getByTestId('mp-reaction')).toHaveCount(1, { timeout: 5_000 })
		await page.waitForTimeout(800)

		const before = await heartProgress()
		expect(before, 'heart emote should be animating before the second tap').not.toBeNull()
		expect(before).toBeGreaterThan(300)

		// Tap a DIFFERENT reaction; it must append, not re-seed the whole set.
		await page.getByTestId('mp-react-fire').click()
		await expect(page.getByTestId('mp-reaction')).toHaveCount(2, { timeout: 5_000 })

		const after = await heartProgress()
		expect(after, 'heart emote should still be present after the second tap').not.toBeNull()
		// The heart animation must have kept running, never rewound to spawn.
		expect(after).toBeGreaterThanOrEqual(before)
		await expect(page.getByTestId('mp-error')).toHaveCount(0)
	})
})
