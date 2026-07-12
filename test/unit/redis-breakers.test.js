import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	createRealtimeBreaker,
	createSessionBreaker
} from '../../src/lib/server/redis-breakers.js'

test('session failures do not open the realtime infrastructure breaker', () => {
	const realtime = createRealtimeBreaker()
	const session = createSessionBreaker()

	for (let attempt = 0; attempt < 5; attempt++) {
		session.failure(new Error('session store unavailable'))
	}

	assert.equal(session.isHealthy, false)
	assert.equal(realtime.isHealthy, true)
	assert.doesNotThrow(() => realtime.guard())
	assert.throws(() => session.guard(), /circuit breaker is open/i)
})
