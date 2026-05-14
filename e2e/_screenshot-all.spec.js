import { test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const OUT = path.resolve('_screenshots')
fs.mkdirSync(OUT, { recursive: true })

const DEMOS = [
	'checkout',
	'counter-resume',
	'chat',
	'todos-rollback',
	'denials',
	'pressure',
	'chaos',
	'notifications',
	'topk',
	'news',
	'jobs',
	'cluster-cron',
	'upload',
	'auctions',
	'schema-evolution',
	'flash-sales',
	'pagination',
	'effect',
	'from-seq'
]

test.use({ viewport: { width: 1366, height: 900 } })
test.setTimeout(45_000)

for (const slug of DEMOS) {
	test(`screenshot /demos/${slug}`, async ({ page }) => {
		await page.goto(`/demos/${slug}`, { waitUntil: 'networkidle' }).catch(() => {})
		await page.waitForTimeout(2500)
		await page.screenshot({
			path: path.join(OUT, `${slug}.png`),
			fullPage: true
		})
	})
}
