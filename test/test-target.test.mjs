import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	assertSafeE2ETarget,
	resolveE2EBaseURL,
	toWebSocketURL,
	toHandshakeOrigin
} from '../scripts/test-target.mjs'

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

test('all supported loopback hosts are accepted', () => {
	for (const host of ['localhost', '127.0.0.1', '[::1]']) {
		assert.equal(resolveE2EBaseURL({ BASE_URL: `http://${host}:4199/` }), `http://${host}:4199`)
	}
})

test('lookalike hosts and credential tricks do not bypass the remote guard', () => {
	for (const target of ['http://localhost.example.com', 'http://127.0.0.1.example.com', 'http://localhost@example.com']) {
		assert.throws(() => assertSafeE2ETarget(target, {}), /Refusing remote E2E target/)
	}
})

test('malformed, file, and WebSocket base URLs fail before a connection', () => {
	assert.throws(() => resolveE2EBaseURL({ BASE_URL: 'not a url' }), /Invalid E2E/)
	assert.throws(() => resolveE2EBaseURL({ BASE_URL: 'file:///etc/passwd' }), /Unsupported/)
	assert.throws(() => resolveE2EBaseURL({ BASE_URL: 'ws://localhost:3000' }), /http or https/)
})

test('WebSocket conversion removes HTTP paths, queries, and fragments', () => {
	assert.equal(toWebSocketURL('http://localhost:3091/board/a?token=x#fragment'), 'ws://localhost:3091/ws')
	assert.equal(toHandshakeOrigin('wss://localhost:3091/ws'), 'https://localhost:3091')
})
