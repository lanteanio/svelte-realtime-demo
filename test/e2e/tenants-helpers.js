import { expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

/**
 * The tenant readout is confirmed over the socket, so waiting on it is a
 * connection wait wearing an app-level costume: when the socket never comes
 * up, `tn-ws-pending` simply never clears and the failure reports a selector,
 * naming nothing about why. Route the connection half through `waitForWS`
 * first so a dead socket or a page that never hydrated reports its own
 * timeline, and keep the tenant confirmation as the app-level gate behind it.
 *
 * Shared by the single-instance and cluster specs rather than written out in
 * each. The two had already drifted - the cluster spec waited on the marker
 * with no connection wait in front of it, on both the open and the post-switch
 * path - and a helper each cannot drift back apart.
 */
export async function waitForWsConfirmed(page) {
	await waitForWS(page)
	await expect(page.getByTestId('tn-ws-pending')).toHaveCount(0, { timeout: 15_000 })
	await expect(page.getByTestId('tn-whoami-error')).toHaveCount(0)
}

/**
 * Switch the connection's tenant and wait for the page it lands on.
 *
 * Switching reloads: the tenant resolver runs once per connection at upgrade,
 * so the page cannot re-scope a live socket. That makes every step after the
 * click a wait on a NEW page - `tn-active-tenant` comes back with the
 * server-rendered document and says only that the reload carried the right
 * cookie, which is why the connection wait behind it is the part that knows
 * whether the client booted at all.
 *
 * @param {import('@playwright/test').Page} page
 * @param {'acme' | 'globex' | null} tenant
 */
export async function switchTenant(page, tenant) {
	const id = tenant === 'acme' ? 'tn-set-acme' : tenant === 'globex' ? 'tn-set-globex' : 'tn-clear'
	await page.getByTestId(id).click()
	await expect(page.getByTestId('tn-active-tenant')).toHaveText(tenant ?? 'none', { timeout: 15_000 })
	await waitForWsConfirmed(page)
}
