import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardHooks } from '../helpers/board-observer.js'

// The app's gates under the hooks realtime() returns, with recording plugins:
// what is refused, and which topic the presence and cursor plugins are given.
function setup() {
	const joined = []
	const plugin = (name) => ({ hooks: { subscribe: (_ws, topic) => { joined.push(`${name} ${topic}`) } } })
	const hooks = boardHooks(plugin('presence'), plugin('cursor'), (user) => user?.tenant ?? null)
	const socket = (user) => ({ getUserData: () => user })
	return { hooks, joined, socket }
}

test('a tenant connection keeps the org and private-room gates and joins plugins on its wire topic', async () => {
	const { hooks, joined, socket } = setup()
	const ws = socket({ id: 'u1', org: 'acme', tenant: 'acme' })

	assert.equal(await hooks.subscribe(ws, '@t/acme/audit:acme', {}), undefined)
	assert.deepEqual(joined.splice(0), ['presence @t/acme/audit:acme', 'cursor @t/acme/audit:acme'])

	for (const topic of ['@t/acme/audit:globex', '@t/acme/demos:chat:private', '@t/acme/demos:chat:private:presence', '@t/globex/audit:acme', '@t/globex/demos:chat:general']) {
		assert.equal(await hooks.subscribe(ws, topic, {}), 'FORBIDDEN', topic)
	}
	assert.deepEqual(joined, [], 'a refused topic joins no plugin')

	const denials = await hooks.subscribeBatch(ws, ['@t/acme/demos:chat:general', '@t/acme/audit:globex', '@t/acme/demos:fromseq:events'], {})
	assert.deepEqual({ ...denials }, { '@t/acme/audit:globex': 'FORBIDDEN' })
	assert.deepEqual(joined.splice(0), [
		'presence @t/acme/demos:chat:general', 'cursor @t/acme/demos:chat:general',
		'presence @t/acme/demos:fromseq:events', 'cursor @t/acme/demos:fromseq:events'
	])
})

test('an untenanted connection is refused tenant topics and joins plugins on the plain topic', async () => {
	const { hooks, joined, socket } = setup()
	const ws = socket({ id: 'u2', org: 'globex', tenant: null })

	assert.equal(await hooks.subscribe(ws, '@t/acme/demos:chat:general', {}), 'FORBIDDEN')
	assert.equal(await hooks.subscribe(ws, 'audit:acme', {}), 'FORBIDDEN')
	assert.equal(await hooks.subscribe(ws, 'demos:chat:private', {}), 'FORBIDDEN')
	assert.deepEqual(joined, [])

	assert.equal(await hooks.subscribe(ws, 'audit:globex', {}), undefined)
	assert.deepEqual(joined.splice(0), ['presence audit:globex', 'cursor audit:globex'])
})
