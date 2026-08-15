import { test, expect } from '@playwright/test'
import { confirmAndClick, waitForWS } from './helpers.js'

test.describe.configure({ mode: 'serial' })

const IDS = ['alpha', 'beta', 'gamma']
const LABELS = ['Alpha counter', 'Beta counter', 'Gamma counter']

async function open(page) {
	await page.goto('/demos/schema-evolution')
	await waitForWS(page)
	await expect(page.getByTestId('v2-card')).toHaveCount(3, { timeout: 8_000 })
	await expect(page.getByTestId('v1mig-card')).toHaveCount(3, { timeout: 8_000 })
}

async function expectValues(page, expected) {
	for (const id of IDS) {
		await expect(page.getByTestId(`v2-value-${id}`)).toHaveText(String(expected[id]))
		await expect(page.getByTestId(`v1mig-value-${id}`)).toHaveText(String(expected[id]))
	}
}

async function expectV1Provenance(page, expected) {
	for (const id of IDS) {
		await expect(page.getByTestId(`v1mig-provenance-${id}`)).toHaveText(expected[id] ?? expected)
	}
}

async function reset(page) {
	await confirmAndClick(page.getByTestId('reset'))
	await expectValues(page, { alpha: 0, beta: 0, gamma: 0 })
	await expectV1Provenance(page, 'loader')
}

async function reloadMigrated(page) {
	await page.reload()
	// A reload is a full navigation and can leave the client bundle dead
	// exactly as a goto can, and callers click as soon as this returns. The
	// count below does eventually notice, but it reports the wrong thing: a
	// dead bundle surfaces as "v2-card expected 3, received 0" after the full
	// eight seconds, naming a content selector rather than the asset that
	// failed to load. Gating first turns that into a readiness failure that
	// names the dead chunk.
	await waitForWS(page)
	await expect(page.getByTestId('v2-card')).toHaveCount(3, { timeout: 8_000 })
	await expectV1Provenance(page, 'migrate[1]')
}

test.describe('/demos/schema-evolution', () => {
	test('renders both exact projections, all controls, server version, and migration source', async ({ page }) => {
		await open(page)
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Schema evolution: subscribe-time migrate hooks')
		expect(await page.getByTestId('v2-label').allTextContents()).toEqual(LABELS)
		expect(await page.getByTestId('v1mig-label').allTextContents()).toEqual(LABELS)
		for (let i = 0; i < 3; i++) await expect(page.getByTestId('v2-provenance').nth(i)).toHaveText('loader')
		await expectV1Provenance(page, 'migrate[1]')
		for (const id of IDS) await expect(page.getByTestId(`bump-${id}`)).toHaveText(`Increment ${id}`)
		await expect(page.getByTestId('reset')).toHaveText('Reset all')
		await expect(page.getByText('server version: 2', { exact: true })).toBeVisible()
		const source = page.getByTestId('migrate-source')
		await expect(source).toContainText('version: 2')
		await expect(source).toContainText('migrate: { 1: v1ToV2 }')
		await expect(source).toContainText("merge: 'crud'")
		await expect(source).toContainText('key: id')
	})

	test('Reset publishes raw v2 loader rows; reload reruns migrate[1] only for the stale projection', async ({ page }) => {
		await open(page)
		await page.getByTestId('bump-alpha').click()
		await expect(page.getByTestId('v2-value-alpha')).not.toHaveText('0')
		await reset(page)
		await reloadMigrated(page)
		await expectValues(page, { alpha: 0, beta: 0, gamma: 0 })
		for (let i = 0; i < 3; i++) await expect(page.getByTestId('v2-provenance').nth(i)).toHaveText('loader')
	})

	test('every increment updates only its key and flips that stale-client row to loader', async ({ page }) => {
		await open(page)
		await reset(page)
		await reloadMigrated(page)
		const expected = { alpha: 0, beta: 0, gamma: 0 }
		const provenance = { alpha: 'migrate[1]', beta: 'migrate[1]', gamma: 'migrate[1]' }
		for (const id of IDS) {
			await page.getByTestId(`bump-${id}`).click()
			expected[id] = 1
			provenance[id] = 'loader'
			await expectValues(page, expected)
			await expectV1Provenance(page, provenance)
		}
	})

	test('three serialized beta clicks converge on value 3 in both projections', async ({ page }) => {
		await open(page)
		await reset(page)
		await reloadMigrated(page)
		for (let value = 1; value <= 3; value++) {
			await page.getByTestId('bump-beta').click()
			await expect(page.getByTestId('v2-value-beta')).toHaveText(String(value))
			await expect(page.getByTestId('v1mig-value-beta')).toHaveText(String(value))
		}
		await expect(page.getByTestId('v1mig-provenance-beta')).toHaveText('loader')
	})

	test('two tabs increment the same Redis field concurrently without losing a count, then share Reset', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([open(a), open(b)])
			await reset(a)
			await Promise.all([reloadMigrated(a), reloadMigrated(b)])
			await Promise.all([
				a.getByTestId('bump-gamma').click(),
				b.getByTestId('bump-gamma').click()
			])
			for (const page of [a, b]) {
				await expect(page.getByTestId('v2-value-gamma')).toHaveText('2')
				await expect(page.getByTestId('v1mig-value-gamma')).toHaveText('2')
				await expect(page.getByTestId('v1mig-provenance-gamma')).toHaveText('loader')
			}
			await reset(b)
			await expectValues(a, { alpha: 0, beta: 0, gamma: 0 })
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
