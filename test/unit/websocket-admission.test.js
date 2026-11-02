import assert from 'node:assert/strict'
import { test } from 'node:test'
import { websocketAdmission } from '../../scripts/websocket-admission.mjs'
import { createUpgradeAdmission } from '../../node_modules/svelte-adapter-uws/src/runtime/utils/upgrade-admission.js'

test('deployment and arbitrary build paths retain finite admission limits', () => {
	for (const env of [{}, { SRD_LOCAL_LOAD_TEST: '1' }, { SRD_LOCAL_LOAD_TEST: '1', BUILD_OUT_DIR: 'build' }]) {
		const config = websocketAdmission(env)
		assert.equal(config.upgradeRateLimit, 100)
		assert.equal(config.authPathRateLimit, 300)
		assert.equal(config.upgradeAdmission.maxConnections, 2000)
	}
})

test('local load tests have a separate finite socket budget', () => {
	const config = websocketAdmission({ SRD_LOCAL_LOAD_TEST: '1', BUILD_OUT_DIR: 'build-runs/srd-build-123-456' })
	assert.equal(config.upgradeRateLimit, 0)
	assert.equal(config.upgradeAdmission.maxConnections, 12000)
})

test('sequential completed handshakes still hold the deployment connection ceiling', () => {
	const admission = createUpgradeAdmission(websocketAdmission({}).upgradeAdmission)
	for (let i = 0; i < 2000; i++) {
		assert.equal(admission.tryAcquireConnection(), true)
		assert.equal(admission.tryAcquire(), true)
		admission.release()
	}
	assert.equal(admission.tryAcquireConnection(), false)
	assert.equal(admission.connectionHeadroom, 0)
	admission.releaseConnection()
	assert.equal(admission.tryAcquireConnection(), true)
	assert.equal(admission.tryAcquireConnection(), false)
})
