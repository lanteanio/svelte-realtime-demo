import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	assertSafeE2ETarget,
	resolveE2EBaseURL,
	toWebSocketURL
} from '../../scripts/test-target.mjs'

test('E2E defaults to an HTTP loopback target', () => {
	assert.equal(resolveE2EBaseURL({}), 'http://127.0.0.1:3000')
})

test('remote E2E targets are rejected without explicit opt-in', () => {
	assert.throws(
		() => assertSafeE2ETarget('https://example.com', {}),
		/Refusing remote E2E target/
	)
})

test('remote E2E targets require ALLOW_REMOTE_E2E=1', () => {
	assert.equal(
		resolveE2EBaseURL({ BASE_URL: 'https://example.com/', ALLOW_REMOTE_E2E: '1' }),
		'https://example.com'
	)
})

test('HTTP targets convert to the matching WebSocket protocol', () => {
	assert.equal(toWebSocketURL('http://localhost:4173'), 'ws://localhost:4173/ws')
	assert.equal(
		toWebSocketURL('https://example.com/base', '/socket', { ALLOW_REMOTE_E2E: '1' }),
		'wss://example.com/socket'
	)
})
