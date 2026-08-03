import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectionState, isOffline } from '../../src/lib/offline-connection.js'

test('a live socket reads online, backgrounded included', () => {
	assert.equal(connectionState('open', false), 'online')
	// A suspended socket is alive on a backgrounded tab, not an outage.
	assert.equal(connectionState('suspended', false), 'online')
})

test('a real outage is reported as one, not papered over as connected', () => {
	// The defect this module exists to prevent: the card branched on the
	// simulation toggle alone, so a genuine network loss still read
	// "Connected." during the exact scenario the demo demonstrates.
	assert.equal(connectionState('disconnected', false), 'down')
	assert.equal(connectionState('failed', false), 'down')
	assert.notEqual(connectionState('disconnected', false), 'online')
})

test('the opening handshake is its own state, not an offline alarm', () => {
	// Every page load passes through 'connecting'. Folding it into 'down'
	// flashes an amber offline card on every visit, before the socket has
	// had any chance to open.
	assert.equal(connectionState('connecting', false), 'connecting')
	assert.notEqual(connectionState('connecting', false), 'down')
	assert.equal(isOffline(connectionState('connecting', false)), false)
})

test('the simulation outranks the socket state it causes', () => {
	// Clicking "Go offline" drops the socket, so status is genuinely down
	// too; the card must still name it as the simulation the visitor chose.
	assert.equal(connectionState('disconnected', true), 'simulated')
	assert.equal(connectionState('open', true), 'simulated')
})

test('queued work is waiting only when simulated or genuinely down', () => {
	assert.equal(isOffline('simulated'), true)
	assert.equal(isOffline('down'), true)
	assert.equal(isOffline('online'), false)
	assert.equal(isOffline('connecting'), false)
})

test('an unknown status is treated as down rather than assumed healthy', () => {
	// Fail closed: a status this map has not seen must not read as online.
	assert.equal(connectionState('something-new', false), 'down')
})
