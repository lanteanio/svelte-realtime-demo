import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { sharedIdentityState } from './helpers.js'
import {
	clearUploads,
	openUpload,
	uploadSyntheticFile,
	waitForFile,
	waitForUpload
} from './upload-helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'upload cluster coverage requires two explicit replica targets')

test.describe('cluster: /demos/upload', () => {
	test('same identity uses most-recent-recipient routing plus cross-replica Redis dedup', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const a = await ctxA.newPage()
		await openUpload(a, `${INSTANCE_A}/demos/upload`)
		const state = await sharedIdentityState(ctxA, INSTANCE_B)
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B, storageState: state })
		const b = await ctxB.newPage()
		await openUpload(b, `${INSTANCE_B}/demos/upload`)
		try {
			await clearUploads(a)
			const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
			const seed = `e2e-upload-cluster-${stamp}`
			const firstName = `${seed}-a.bin`
			await uploadSyntheticFile(a, { seed, sizeBytes: 200 * 1024, filename: firstName })
			const first = await waitForUpload(a, firstName)
			await waitForFile(b, firstName)
			await expect(b.getByTestId('incoming-filename').first()).toHaveText(firstName, { timeout: 10_000 })

			const secondName = `${seed}-b.bin`
			await uploadSyntheticFile(b, { seed, sizeBytes: 200 * 1024, filename: secondName })
			const second = await waitForUpload(b, secondName)
			expect(second).toEqual({ totalChunks: first.totalChunks, dedupedChunks: first.totalChunks })
			await waitForFile(a, secondName)
			// B remains the cluster-canonical, most-recent connection for this
			// user, so its own upload notifies B again; userId routing is not
			// an all-device broadcast and A must not receive this notification.
			await expect(b.getByTestId('incoming-filename').first()).toHaveText(secondName, { timeout: 10_000 })
			await expect(a.getByTestId('incoming-filename').filter({ hasText: secondName })).toHaveCount(0)
			await clearUploads(a)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
