import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { availability, hashes } from '../fixtures/identity-redis.js'
import { rpcBudgetKey } from '../../src/lib/server/rpc-budget-key.js'

// Keep the production session implementation and replace only Redis transport.
const aliases = {
	'$lib/server/redis': new URL('../fixtures/identity-redis.js', import.meta.url).href,
	'$lib/server/redis-breakers': new URL('../../src/lib/server/redis-breakers.js', import.meta.url).href,
	'$lib/server/env-int': new URL('../../src/lib/server/env-int.js', import.meta.url).href,
	'$lib/server/session-admission': new URL('../../src/lib/server/session-admission.js', import.meta.url).href,
	'$lib/server/tenants': new URL('../../src/lib/server/tenants.js', import.meta.url).href,
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
	const untrustedProfile = { id: victim, ...profile }
	const first = await sessions.createSession(untrustedProfile)
	const second = await sessions.createSession(untrustedProfile)
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
	const untrustedProfile = { id: victim, ...profile }
	availability.failed = true
	try {
		const result = await sessions.createSession(untrustedProfile)
		assert.notEqual(result.identity.id, victim)
		assert.equal(result.sessionId, null)
		assert.deepEqual(result.identity, { id: result.identity.id, ...profile, tenant: null })
		assert.equal(hashes.has(`test:identity-session:${result.sessionId}`), false)
	} finally { availability.failed = false }
})

test('a full session store creates no bearer or persistent identity', async () => {
	const before = new Map(hashes)
	availability.full = true
	try {
		const result = await sessions.createSession(profile)
		assert.equal(result.sessionId, null)
		assert.match(result.identity.id, /^[0-9a-f-]{36}$/)
		assert.deepEqual(hashes, before)
	} finally { availability.full = false }
})

// Execute the upgrade export from the actual hook file with the real session
// implementation. The rest of the hook module boots unrelated infrastructure.
const hookSource = readFileSync(new URL('../../src/hooks.ws.js', import.meta.url), 'utf8')
const upgradeSource = hookSource.match(/export async function upgrade\([^]*?^}/m)?.[0]
assert.ok(upgradeSource, 'upgrade export must be present')
const upgrade = runInNewContext(`(${upgradeSource.replace('export ', '')})`, {
	...sessions,
	env: {},
	evaluateUpgradeOrigin: () => ({ allowed: true }),
	upgradeOriginPolicy: () => ({})
})

test('cookie-less and legacy upgrades leave no stored sessions or mutated cookies', async () => {
	const before = new Map(hashes)
	const victim = randomUUID()
	const legacy = JSON.stringify({ id: victim, ...profile, tenant: 'globex' })
	const ids = new Set()
	const budgets = new Set()
	for (const raw of [undefined, '', 'invalid', legacy, 'A'.repeat(22)]) {
		for (let i = 0; i < 20; i++) {
			const cookies = raw === undefined ? {} : { identity: raw }
			const original = { ...cookies }
			const identity = await upgrade({ headers: {}, cookies })
			assert.deepEqual(cookies, original)
			assert.match(identity.id, /^[0-9a-f-]{36}$/)
			assert.notEqual(identity.id, victim)
			assert.equal(identity.tenant, null)
			assert.equal(identity.anonymous, true)
			if (raw === legacy) assert.deepEqual({ ...identity }, { id: identity.id, ...profile, tenant: null, anonymous: true })
			ids.add(identity.id)
			budgets.add(rpcBudgetKey({ getUserData: () => ({ ...identity, remoteAddress: '192.0.2.1' }) }))
		}
	}
	assert.equal(ids.size, 100)
	assert.equal(budgets.size, 1)
	assert.deepEqual(hashes, before)
})

test('an upgrade with an HTTP-issued session retains its stored identity', async () => {
	const session = await sessions.createSession(profile)
	const before = new Map(hashes)
	const cookies = Object.freeze({ identity: session.sessionId })
	assert.deepEqual(await upgrade({ headers: {}, cookies }), session.identity)
	assert.deepEqual(await upgrade({ headers: {}, cookies }), session.identity)
	assert.deepEqual(hashes, before)
})
