import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	REDIS_COMMAND_TIMEOUT_MS,
	REDIS_CONNECT_TIMEOUT_MS,
	REDIS_MAX_RETRIES_PER_REQUEST,
	REDIS_RETRY_MAX_DELAY_MS,
	redisConnectionOptions
} from '../../src/lib/server/redis-options.js'

test('Redis commands and initial connects have finite failure bounds', () => {
	const options = redisConnectionOptions()
	assert.equal(options.lazyConnect, true)
	assert.equal(options.connectTimeout, REDIS_CONNECT_TIMEOUT_MS)
	assert.equal(options.commandTimeout, REDIS_COMMAND_TIMEOUT_MS)
	assert.equal(options.maxRetriesPerRequest, REDIS_MAX_RETRIES_PER_REQUEST)
	assert.ok(options.commandTimeout <= 2000)
})

test('Redis reconnect backoff is capped while allowing recovery', () => {
	const { retryStrategy } = redisConnectionOptions()
	assert.equal(retryStrategy(1), 200)
	assert.equal(retryStrategy(5), 1000)
	assert.equal(retryStrategy(100), REDIS_RETRY_MAX_DELAY_MS)
})
