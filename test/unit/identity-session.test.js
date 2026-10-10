import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { availability, hashes } from '../fixtures/identity-redis.js'

// Keep the production session implementation and replace only Redis transport.
const aliases = {
	'$lib/server/redis': new URL('../fixtures/identity-redis.js', import.meta.url).href,
	'$lib/server/redis-breakers': new URL('../../src/lib/server/redis-breakers.js', import.meta.url).href,
	'$lib/server/env-int': new URL('../../src/lib/server/env-int.js', import.meta.url).href,
	'$lib/names': new URL('../../src/lib/names.js', import.meta.url).href
}
const hooks = registerHooks({ resolve(specifier, context, next) {
	return aliases[specifier] ? { url: aliases[specifier], shortCircuit: true } : next(specifier, context)
} })
let sessions
try { sessions = await import('../../src/lib/server/identity-session.js') }
finally { hooks.deregister() }

const profile = { name: 'Quiet Visitor', color: '#aabbcc', org: 'globex' }

test('legacy migration extracts profile hints without an identity or tenant', () => {
	const legacy = { id: randomUUID(), ...profile, tenant: 'globex', sessionId: 'attacker' }
	assert.deepEqual(sessions.tryParseLegacyJsonCookie(JSON.stringify(legacy)), profile)
	for (const raw of [null, 'invalid', '{}', JSON.stringify({ ...legacy, id: 'invalid' }), JSON.stringify({ ...legacy, color: 'red' })]) {
		assert.equal(sessions.tryParseLegacyJsonCookie(raw), null)
	}
})

test('session creation ignores a supplied identity ID and persists its own ID', async () => {
	const victim = randomUUID()
	const first = await sessions.createSession({ id: victim, ...profile })
	const second = await sessions.createSession({ id: victim, ...profile })
	assert.notEqual(first.identity.id, victim)
	assert.notEqual(second.identity.id, victim)
	assert.notEqual(first.identity.id, second.identity.id)
	assert.match(first.identity.id, /^[0-9a-f-]{36}$/)
	assert.match(first.sessionId, /^[A-Za-z0-9_-]{22}$/)
	assert.notEqual(first.sessionId, second.sessionId)
	assert.deepEqual(first.identity, { id: first.identity.id, ...profile, tenant: null })
	assert.deepEqual(await sessions.lookupSession(first.sessionId), first.identity)
	assert.deepEqual(await sessions.lookupSession(first.sessionId), first.identity)
	assert.equal(hashes.get(`test:identity-session:${first.sessionId}`).id, first.identity.id)
})

test('an unavailable session store cannot turn a legacy hint into a victim identity', async () => {
	const victim = randomUUID()
	availability.failed = true
	try {
		const result = await sessions.createSession({ id: victim, ...profile })
		assert.notEqual(result.identity.id, victim)
		assert.deepEqual(result.identity, { id: result.identity.id, ...profile, tenant: null })
		assert.equal(hashes.has(`test:identity-session:${result.sessionId}`), false)
	} finally { availability.failed = false }
})
