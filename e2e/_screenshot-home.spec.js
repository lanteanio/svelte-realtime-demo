import { test } from '@playwright/test'

test.use({ viewport: { width: 1366, height: 900 } })

test('screenshot /', async ({ page }) => {
	await page.goto('/', { waitUntil: 'networkidle' }).catch(() => {})
	await page.waitForTimeout(1500)
	await page.screenshot({ path: '_screenshots/home.png', fullPage: true })
})

test('screenshot / with filter "lock"', async ({ page }) => {
	await page.goto('/', { waitUntil: 'networkidle' }).catch(() => {})
	await page.waitForTimeout(1000)
	await page.getByTestId('demos-filter').fill('lock')
	await page.waitForTimeout(300)
	await page.screenshot({ path: '_screenshots/home-filter-lock.png', fullPage: true })
})
