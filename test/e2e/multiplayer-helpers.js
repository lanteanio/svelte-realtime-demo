import { expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

export const REACTION_TOKENS = ['heart', 'fire', 'clap', 'star']

export async function openMultiplayer(page, target = '/demos/multiplayer') {
	await page.goto(target)
	await waitForWS(page)
	await expect(page.getByTestId('mp-roster')).toContainText('(you)', { timeout: 15_000 })
	await expect(page.getByTestId('mp-headline-display')).not.toHaveText('loading...', { timeout: 15_000 })
}

export async function participantName(page) {
	const text = await page.getByTestId('mp-roster').locator('li').filter({ hasText: '(you)' }).textContent()
	return text.replace(/\s*\(you\)\s*$/, '').trim()
}

export async function waitForPeers(a, b) {
	const [nameA, nameB] = await Promise.all([participantName(a), participantName(b)])
	await expect(a.getByTestId('mp-roster-other').filter({ hasText: nameB })).toHaveCount(1, { timeout: 15_000 })
	await expect(b.getByTestId('mp-roster-other').filter({ hasText: nameA })).toHaveCount(1, { timeout: 15_000 })
	return { nameA, nameB }
}

export function cursorFor(page, name) {
	return page.getByTestId('mp-cursor').filter({ hasText: name })
}

export async function moveCursor(page, x, y) {
	const canvas = page.getByTestId('mp-canvas')
	const box = await canvas.boundingBox()
	if (!box) throw new Error('multiplayer canvas has no bounding box')
	await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 8 })
}

export async function expectNoMultiplayerErrors(...pages) {
	for (const page of pages) {
		await expect(page.getByTestId('mp-error')).toHaveCount(0)
		await expect(page.getByTestId('mp-feed-error')).toHaveCount(0)
	}
}

export async function waitForReactionCount(page, count) {
	await expect(page.getByTestId('mp-reaction')).toHaveCount(count, { timeout: 10_000 })
}

export async function tapReaction(page, token, expectedCount) {
	await page.getByTestId(`mp-react-${token}`).click()
	await waitForReactionCount(page, expectedCount)
	const handles = await page.getByTestId('mp-reaction').elementHandles()
	return handles.at(-1)
}

export async function animationTime(handle) {
	return handle.evaluate((node) => Number(node.getAnimations()[0]?.currentTime ?? 0))
}

export async function isConnected(handle) {
	// Distinguish "the node left the DOM" (the thing under test) from "the
	// evaluate failed" (disposed handle, destroyed execution context). Callers
	// assert both true and false here; collapsing an infrastructure failure to
	// `false` makes every `toBe(false)` assertion pass without a real prune.
	try {
		return await handle.evaluate((node) => node.isConnected)
	} catch (err) {
		if (/not connected|no longer|detached|Node with given id/i.test(String(err?.message))) return false
		throw err
	}
}
