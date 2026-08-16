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

const PEER_TIMEOUT = 15_000

/**
 * Read one page's roster: its own name plus every other entry it renders.
 *
 * Reads the DOM in one evaluate rather than through locators, so a caller
 * describing a failure gets one consistent snapshot instead of several
 * separately-resolved ones taken while the roster is still moving.
 */
export async function readRoster(page) {
	return page.evaluate(() => {
		const roster = document.querySelector('[data-testid="mp-roster"]')
		if (!roster) return { present: false, self: null, others: [] }
		const selfNode = [...roster.querySelectorAll('li')].find((li) => li.textContent.includes('(you)'))
		return {
			present: true,
			self: selfNode ? selfNode.textContent.replace(/\s*\(you\)\s*$/, '').trim() : null,
			others: [...document.querySelectorAll('[data-testid="mp-roster-other"]')].map((li) => li.textContent.trim())
		}
	}).catch(() => ({ present: false, self: null, others: [], evaluateFailed: true }))
}

/**
 * Name what a failed peer wait actually observed.
 *
 * "Expected 1, received 0" is true of every one of the states below, and they
 * have different causes and different owners, so a bare count leaves the
 * reader to re-derive by hand which one fired:
 *
 *   one side blind      -> the join reached the room, since the other side has
 *                          it; one direction of the fan-out was never delivered
 *   both sides blind    -> no join was delivered in either direction
 *   own entry missing   -> the page is not rendering itself, so the question is
 *                          identity or hydration rather than presence delivery
 *   entries but no match -> a membership arrived carrying the wrong name
 *   both present now    -> it converged after the wait expired, which is latency
 *
 * The rosters are dumped verbatim underneath so the verdict can be checked
 * rather than trusted.
 */
async function describePeerFailure(a, b, nameA, nameB, budget) {
	const [ra, rb] = await Promise.all([readRoster(a), readRoster(b)])
	const aSeesB = ra.others.some((o) => o.includes(nameB))
	const bSeesA = rb.others.some((o) => o.includes(nameA))
	const lines = []

	if (!ra.present || !rb.present) {
		lines.push('VERDICT: a roster did not render at all, so this is not a presence-delivery failure.')
	} else if (ra.self == null || rb.self == null) {
		lines.push('VERDICT: a side does not render its own entry. Identity or hydration, not presence delivery.')
	} else if (aSeesB && bSeesA) {
		lines.push(`VERDICT: both directions are present now, so the roster converged after the ${budget}ms budget expired. Latency, not a lost join.`)
	} else if (aSeesB !== bSeesA) {
		// aSeesB false means A is the side missing its peer, so A is blind and B
		// is the one that received the join.
		const blind = aSeesB ? rb.self : ra.self
		const seen = aSeesB ? ra.self : rb.self
		lines.push(`VERDICT: asymmetric. ${seen} received the other join, ${blind} never received it, and ${blind} renders its own entry - so its socket is live and one direction of the fan-out was lost.`)
	} else {
		lines.push('VERDICT: symmetric. Neither direction was delivered.')
	}

	for (const [label, roster, wanted] of [['a', ra, nameB], ['b', rb, nameA]]) {
		if (roster.present && roster.others.length && !roster.others.some((o) => o.includes(wanted))) {
			lines.push(`NOTE: ${label} rendered ${roster.others.length} other entr${roster.others.length === 1 ? 'y' : 'ies'}, none carrying ${wanted}. A membership arrived with a name that does not match.`)
		}
	}

	lines.push(`a: self=${JSON.stringify(ra.self)} others=${JSON.stringify(ra.others)}`)
	lines.push(`b: self=${JSON.stringify(rb.self)} others=${JSON.stringify(rb.others)}`)
	return `--- presence roster at failure ---\n${lines.join('\n')}`
}

/**
 * `timeout` exists so the test that proves the failure description works can
 * reach it in seconds instead of burning the full convergence budget waiting
 * for a state it has already forced. Callers waiting on real convergence
 * should leave it alone.
 */
export async function waitForPeers(a, b, timeout = PEER_TIMEOUT) {
	const [nameA, nameB] = await Promise.all([participantName(a), participantName(b)])
	try {
		await expect(a.getByTestId('mp-roster-other').filter({ hasText: nameB })).toHaveCount(1, { timeout })
		await expect(b.getByTestId('mp-roster-other').filter({ hasText: nameA })).toHaveCount(1, { timeout })
	} catch (error) {
		// Enrich and rethrow. Describing the failure must never convert it into a
		// pass, so nothing here is allowed to swallow the original error - and if
		// the description itself throws, the wait still has to fail loudly.
		const described = await describePeerFailure(a, b, nameA, nameB, timeout).catch(
			(err) => `--- presence roster at failure ---\ncapture failed: ${err?.message ?? err}`
		)
		error.message = `${error.message}\n\n${described}`
		throw error
	}
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
