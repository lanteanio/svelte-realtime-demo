import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rpcBudgetKey } from '../../src/lib/server/rpc-budget-key.js'

const connection = (id, remoteAddress, anonymous = true) => ({ getUserData: () => ({ id, remoteAddress, anonymous }) })

test('cookie-less reconnects cannot renew the abuse key by rotating identities', () => {
	const keys = new Set(Array.from({ length: 1000 }, (_, id) => rpcBudgetKey(connection(String(id), '192.0.2.1'))))
	assert.equal(keys.size, 1)
	const [key] = keys
	assert.match(key, /^anonymous:[0-9a-f]{64}$/)
	assert.ok(!key.includes('192.0.2.1'))
	assert.notEqual(key, rpcBudgetKey(connection('same', '192.0.2.2')))
})

test('IPv6 aliases and address rotation inside a subnet share the anonymous budget', () => {
	const key = rpcBudgetKey(connection('a', '2001:db8:1234:abcd::1'))
	assert.equal(key, rpcBudgetKey(connection('b', '2001:0db8:1234:abcd:0:0:0:ffff')))
	assert.notEqual(key, rpcBudgetKey(connection('c', '2001:db8:1234:abce::1')))
	assert.equal(rpcBudgetKey(connection('d', '::ffff:192.0.2.1')), rpcBudgetKey(connection('e', '192.0.2.1')))
})

test('HTTP-issued identities keep independent budgets behind one address', () => {
	assert.equal(rpcBudgetKey(connection('one', '192.0.2.1', false)), 'user:one')
	assert.equal(rpcBudgetKey(connection('two', '192.0.2.1', false)), 'user:two')
	assert.equal(rpcBudgetKey(connection('one', '192.0.2.2', false)), 'user:one')
})
