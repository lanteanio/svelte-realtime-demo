import assert from 'node:assert/strict'
import test from 'node:test'
import { observeRedisCommandRejections } from '../../src/lib/server/redis-command-safety.js'

test('Redis command observer preserves the original Promise and rejection', async () => {
	const error = new Error('offline')
	let receiver
	const client = {
		sendCommand(..._args) {
			receiver = this
			return Promise.reject(error)
		}
	}

	observeRedisCommandRejections(client)
	const pending = client.sendCommand('PING')
	assert.equal(receiver, client)
	await assert.rejects(pending, error)
})

test('Redis command observer is idempotent', () => {
	const pending = Promise.resolve('PONG')
	const client = { sendCommand: (..._args) => pending }
	observeRedisCommandRejections(client)
	const wrapped = client.sendCommand
	observeRedisCommandRejections(client)
	assert.equal(client.sendCommand, wrapped)
	assert.equal(client.sendCommand('PING'), pending)
})
