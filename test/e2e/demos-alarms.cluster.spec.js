import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { switchTenant, waitForWsConfirmed } from './tenants-helpers.js'
import { watchWire } from './helpers.js'
import {
	cancelPending,
	expectCountdownBetween,
	expectRecentAlarmCount,
	openAlarms,
	recentAlarms,
	scheduleCustom
} from './alarms-helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'alarms cluster coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

async function openAt(page, origin) {
	await openAlarms(page, `${origin}/demos/alarms`)
}

async function readFreshRoom(page, origin) {
	const wire = watchWire(page)
	await openAt(page, origin)
	const snapshot = () => wire.rpcs.find((rpc) => rpc.rpc === 'demos/alarms/timers' && rpc.ok === true && Number.isInteger(rpc.rows))
	await expect.poll(() => snapshot()?.rows ?? -1).toBeGreaterThanOrEqual(0)
	await expect(page.getByTestId('al-log-row')).toHaveCount(snapshot().rows)
}

async function twoReplicas(browser) {
	const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
	const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
	const a = await ctxA.newPage()
	const b = await ctxB.newPage()
	await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
	return { ctxA, ctxB, a, b }
}

test.describe('cluster: /demos/alarms', () => {
	test('tenant schedules, firing and cancellation stay isolated across replicas', async ({ browser }) => {
		test.setTimeout(90_000)
		const scopes = [
			{ origin: INSTANCE_A, tenant: 'acme' },
			{ origin: INSTANCE_B, tenant: 'acme' },
			{ origin: INSTANCE_B, tenant: 'globex' },
			{ origin: INSTANCE_A, tenant: null }
		]
		const visitors = []
		try {
			for (const scope of scopes) {
				const context = await browser.newContext({ baseURL: scope.origin })
				const page = await context.newPage()
				visitors.push({ context, page })
				await page.goto('/demos/tenants')
				await waitForWsConfirmed(page)
				if (scope.tenant !== null) await switchTenant(page, /** @type {'acme' | 'globex'} */ (scope.tenant))
				await openAt(page, scope.origin)
			}
			const [a, b, other, unscoped] = visitors.map(({ page }) => page)
			for (const page of [a, other, unscoped]) await cancelPending(page)
			const since = Date.now() - 1_000
			await scheduleCustom(unscoped, 300)
			await expectCountdownBetween(unscoped, 290, 300)
			const publicDeadline = await unscoped.getByTestId('al-pending-at').locator('span').first().textContent()
			await scheduleCustom(other, 240)
			await expectCountdownBetween(other, 230, 240)
			const otherDeadline = await other.getByTestId('al-pending-at').locator('span').first().textContent()
			await scheduleCustom(a, 4)
			await expectCountdownBetween(b, 1, 4)
			await Promise.all([expectRecentAlarmCount(a, since, 1), expectRecentAlarmCount(b, since, 1)])
			expect(await recentAlarms(a, since)).toEqual(await recentAlarms(b, since))
			await readFreshRoom(b, INSTANCE_B)
			await expectRecentAlarmCount(b, since, 1)
			await readFreshRoom(other, INSTANCE_B)
			await readFreshRoom(unscoped, INSTANCE_A)
			await expect(other.getByTestId('al-pending-at').locator('span').first()).toHaveText(otherDeadline)
			await expect(unscoped.getByTestId('al-pending-at').locator('span').first()).toHaveText(publicDeadline)
			expect(await recentAlarms(other, since)).toEqual([])
			expect(await recentAlarms(unscoped, since)).toEqual([])
			await scheduleCustom(b, 60)
			await expectCountdownBetween(a, 50, 60)
			await cancelPending(a)
			await expect(b.getByTestId('al-pending-empty')).toBeVisible()
			await readFreshRoom(other, INSTANCE_B)
			await readFreshRoom(unscoped, INSTANCE_A)
			await expect(other.getByTestId('al-pending-at').locator('span').first()).toHaveText(otherDeadline)
			await expect(unscoped.getByTestId('al-pending-at').locator('span').first()).toHaveText(publicDeadline)
		} finally {
			await Promise.allSettled(visitors.map(async ({ page, context }) => {
				try { await cancelPending(page) } finally { await context.close() }
			}))
		}
	})

	test('schedule and replacement on separate replicas converge, then remote cancel clears both', async ({ browser }) => {
		const pair = await twoReplicas(browser)
		try {
			await cancelPending(pair.a)
			await expect(pair.b.getByTestId('al-pending-empty')).toBeVisible()

			await pair.a.getByTestId('al-schedule-120').click()
			await expectCountdownBetween(pair.b, 110, 120)
			await pair.b.getByTestId('al-schedule-10').click()
			await expectCountdownBetween(pair.a, 5, 10)

			await pair.a.getByTestId('al-cancel').click()
			for (const page of [pair.a, pair.b]) {
				await expect(page.getByTestId('al-pending-empty')).toBeVisible({ timeout: 5_000 })
			}
		} finally {
			await Promise.allSettled([pair.ctxA.close(), pair.ctxB.close()])
		}
	})

	test('one alarm fires exactly once cluster-wide and both replicas render the same record', async ({ browser }) => {
		const pair = await twoReplicas(browser)
		try {
			await cancelPending(pair.a)
			const since = Date.now() - 1_000
			await scheduleCustom(pair.a, 2)
			await expectCountdownBetween(pair.b, 1, 2)
			await Promise.all([
				expectRecentAlarmCount(pair.a, since, 1),
				expectRecentAlarmCount(pair.b, since, 1)
			])
			const [rowsA, rowsB] = await Promise.all([
				recentAlarms(pair.a, since),
				recentAlarms(pair.b, since)
			])
			expect(rowsA).toHaveLength(1)
			expect(rowsB).toEqual(rowsA)
			for (const page of [pair.a, pair.b]) {
				await expect(page.getByTestId('al-pending-empty')).toBeVisible({ timeout: 5_000 })
			}
			await pair.a.waitForTimeout(2_500)
			expect(await recentAlarms(pair.a, since)).toHaveLength(1)
			expect(await recentAlarms(pair.b, since)).toHaveLength(1)
		} finally {
			await Promise.allSettled([pair.ctxA.close(), pair.ctxB.close()])
		}
	})

	test('the shared durable alarm fires after clients on both replicas disconnect', async ({ browser }) => {
		const pair = await twoReplicas(browser)
		const since = Date.now() - 1_000
		try {
			await cancelPending(pair.a)
			await scheduleCustom(pair.b, 2)
			await expectCountdownBetween(pair.a, 1, 2)
		} finally {
			await Promise.allSettled([pair.ctxA.close(), pair.ctxB.close()])
		}

		await new Promise((resolve) => setTimeout(resolve, 3_500))
		const verifyContext = await browser.newContext({ baseURL: INSTANCE_A })
		const verify = await verifyContext.newPage()
		try {
			await openAt(verify, INSTANCE_A)
			await expectRecentAlarmCount(verify, since, 1, 8_000)
			await expect(verify.getByTestId('al-pending-empty')).toBeVisible()
		} finally {
			await verifyContext.close()
		}
	})
})
