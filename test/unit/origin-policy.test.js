import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	deploymentHosts,
	evaluateUpgradeOrigin,
	isAcceptableHost,
	upgradeOriginPolicy
} from '../../src/lib/server/origin-policy.js'
import { toHandshakeOrigin } from '../../scripts/test-target.mjs'

const deployed = { hasDeclaredOrigin: true, allowOriginless: false }

test('a handshake with no Origin is refused once a canonical origin is configured', () => {
	const decision = evaluateUpgradeOrigin(undefined, deployed)
	assert.equal(decision.allowed, false)
	assert.equal(decision.reason, 'originless_refused')
})

test('an empty Origin header is treated as absent, not as a value that passes', () => {
	assert.equal(evaluateUpgradeOrigin('', deployed).allowed, false)
})

test('a bare checkout with no declared origin keeps accepting Origin-less clients', () => {
	const decision = evaluateUpgradeOrigin(undefined, {
		hasDeclaredOrigin: false,
		allowOriginless: false
	})
	assert.equal(decision.allowed, true)
	assert.equal(decision.reason, 'no_declared_origin')
})

test('the opt-out re-admits Origin-less clients on a configured deployment', () => {
	const decision = evaluateUpgradeOrigin(undefined, {
		hasDeclaredOrigin: true,
		allowOriginless: true
	})
	assert.equal(decision.allowed, true)
	assert.equal(decision.reason, 'originless_opt_in')
})

test('a present Origin is passed through, having already been matched upstream', () => {
	// Includes an origin the adapter would have refused: if one ever reaches
	// the hook the adapter's comparison has changed, and this pass-through
	// documents that the hook is deliberately not a second origin check.
	assert.equal(evaluateUpgradeOrigin('https://example.com', deployed).allowed, true)
	assert.equal(evaluateUpgradeOrigin('https://elsewhere.test', deployed).allowed, true)
})

test('policy reads either origin variable and the opt-out flag', () => {
	assert.deepEqual(upgradeOriginPolicy({ ORIGIN: ' https://example.com ' }), {
		hasDeclaredOrigin: true,
		allowOriginless: false
	})
	// A multi-hostname deployment names ALLOWED_ORIGINS instead of ORIGIN and
	// has declared itself just as much, so it must not leave the gate open.
	assert.equal(upgradeOriginPolicy({ ALLOWED_ORIGINS: 'https://a.example' }).hasDeclaredOrigin, true)
	assert.equal(upgradeOriginPolicy({ ORIGIN: '   ' }).hasDeclaredOrigin, false)
	assert.equal(upgradeOriginPolicy({ WS_ALLOW_ORIGINLESS: '1' }).allowOriginless, true)
	assert.equal(upgradeOriginPolicy({ WS_ALLOW_ORIGINLESS: 'true' }).allowOriginless, false)
	assert.equal(upgradeOriginPolicy({}).hasDeclaredOrigin, false)
})

test('every declared hostname is accepted, not only the canonical one', () => {
	// The case a host check built from ORIGIN alone gets wrong: the apex is
	// served and the www name it also answers to is refused.
	const hosts = deploymentHosts({
		ORIGIN: 'https://example.com',
		ALLOWED_ORIGINS: 'https://example.com,https://www.example.com'
	})
	assert.deepEqual([...hosts].sort(), ['example.com', 'www.example.com'])
	assert.equal(isAcceptableHost('www.example.com', hosts), true)
	assert.equal(isAcceptableHost('example.com', hosts), true)
	assert.equal(isAcceptableHost('not-this-deployment.example', hosts), false)
})

test('a non-default port is part of the host, and loopback is always served', () => {
	const hosts = deploymentHosts({ ORIGIN: 'http://127.0.0.1:3091' })
	assert.deepEqual([...hosts], ['127.0.0.1:3091'])
	// Health probes and the local tier address the server directly.
	assert.equal(isAcceptableHost('localhost:4173', hosts), true)
	assert.equal(isAcceptableHost('[::1]:3000', hosts), true)
	assert.equal(isAcceptableHost(null, hosts), false)
})

test('a checkout declaring nothing serves every Host, and one bad entry is not fatal', () => {
	assert.equal(isAcceptableHost('anything.example', deploymentHosts({})), true)
	// A typo in the list must constrain rather than refuse everything.
	const hosts = deploymentHosts({ ALLOWED_ORIGINS: 'not a url,https://good.example' })
	assert.deepEqual([...hosts], ['good.example'])
	assert.equal(isAcceptableHost('good.example', hosts), true)
	assert.equal(isAcceptableHost('not a url', hosts), false)
})

test('load generators derive a handshake Origin that matches their target host', () => {
	assert.equal(toHandshakeOrigin('ws://127.0.0.1:3091/ws'), 'http://127.0.0.1:3091')
	assert.equal(
		toHandshakeOrigin('wss://example.com/ws', { ALLOW_REMOTE_E2E: '1' }),
		'https://example.com'
	)
	// The default port is omitted, which is what the server compares against.
	assert.equal(
		toHandshakeOrigin('wss://example.com:443/ws', { ALLOW_REMOTE_E2E: '1' }),
		'https://example.com'
	)
})
