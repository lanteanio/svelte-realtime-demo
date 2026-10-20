import assert from 'node:assert/strict'
import test from 'node:test'
import { createBoardPresenceLifecycle, usesExplicitBoardPresenceLifecycle } from '../../src/lib/server/board-presence.js'

function harness({ failAttach = false, denyGrant = false, syncGate = null } = {}) {
	const roles = new Set()
	const grants = new Set()
	const calls = []
	const ws = {}
	const platform = {
		async subscribe(_ws, topic) {
			calls.push(['grant', topic])
			if (denyGrant) return 'FORBIDDEN'
			grants.add(topic)
			return null
		},
		unsubscribe(_ws, topic) { calls.push(['revoke', topic]); grants.delete(topic) }
	}
	const presence = {
		async join(_ws, topic) { assert.ok(grants.has(topic)); roles.add('participant') },
		async sync(_ws, topic) {
			assert.ok(grants.has(topic))
			if (syncGate) await syncGate
			roles.add('observer')
		},
		async leave() { roles.delete(roles.has('participant') ? 'participant' : 'observer') },
		hooks: { async unsubscribe() { roles.delete('observer') } }
	}
	const cursor = {
		async attach() { if (failAttach) throw new Error('attach unavailable'); roles.add('cursor') },
		detach() { roles.delete('cursor') },
		async remove() {}
	}
	const lifecycle = createBoardPresenceLifecycle({ presence, cursor })
	return { lifecycle, roles, grants, calls, ctx: () => ({ ws, platform }) }
}

const topic = '@t/acme/board:12345678-1234-1234-1234-123456789abc'

test('canonical and role board topics bypass automatic plugin participation in every scope', () => {
	for (const prefix of ['', '@t/acme/']) {
		for (const role of ['', ':observer', ':participant']) {
			assert.equal(usesExplicitBoardPresenceLifecycle(`${prefix}board:12345678-1234-1234-1234-123456789abc${role}`), true)
		}
	}
	for (const other of ['global', 'board:123:notes', '@t/acme/demos:chat:public']) {
		assert.equal(usesExplicitBoardPresenceLifecycle(other), false)
	}
})

for (const first of ['observer', 'participant']) {
	test(`leaving ${first} preserves the other role and shared grant`, async () => {
		const h = harness()
		for (const role of ['observer', 'participant']) {
			const ctx = h.ctx()
			await h.lifecycle.attach(ctx, `${topic}:${role}`, role)
			assert.deepEqual(h.lifecycle.load(ctx), { topic })
		}
		assert.deepEqual(h.roles, new Set(['observer', 'participant', 'cursor']))
		await h.lifecycle.detach(h.ctx(), `${topic}:${first}`, first)
		assert.deepEqual(h.roles, new Set(first === 'observer' ? ['participant', 'cursor'] : ['observer']))
		assert.ok(h.grants.has(topic))
		const last = first === 'observer' ? 'participant' : 'observer'
		await h.lifecycle.detach(h.ctx(), `${topic}:${last}`, last)
		assert.equal(h.roles.size, 0)
		assert.equal(h.grants.size, 0)
		assert.deepEqual(h.calls, [['grant', topic], ['revoke', topic]])
	})
}

test('partial participant attach rolls back without evicting an observer', async () => {
	const h = harness({ failAttach: true })
	const observer = h.ctx()
	await h.lifecycle.attach(observer, `${topic}:observer`, 'observer')
	h.lifecycle.load(observer)
	const participant = h.ctx()
	await h.lifecycle.attach(participant, `${topic}:participant`, 'participant')
	assert.throws(() => h.lifecycle.load(participant), { code: 'REALTIME_UNAVAILABLE' })
	await h.lifecycle.detach(h.ctx(), `${topic}:participant`, 'participant')
	assert.deepEqual(h.roles, new Set(['observer']))
	assert.ok(h.grants.has(topic))
	await h.lifecycle.detach(h.ctx(), `${topic}:observer`, 'observer')
	assert.equal(h.grants.size, 0)
})

test('denied canonical grant never starts a plugin role', async () => {
	const h = harness({ denyGrant: true })
	const ctx = h.ctx()
	await h.lifecycle.attach(ctx, `${topic}:observer`, 'observer')
	assert.throws(() => h.lifecycle.load(ctx), { code: 'FORBIDDEN' })
	await h.lifecycle.detach(h.ctx(), `${topic}:observer`, 'observer')
	assert.equal(h.roles.size, 0)
	assert.equal(h.grants.size, 0)
})

test('cleanup queued during an awaited snapshot drains its eventual role', async () => {
	let release = () => {}
	const gate = new Promise((resolve) => { release = () => resolve(undefined) })
	const h = harness({ syncGate: gate })
	const ctx = h.ctx()
	const attached = h.lifecycle.attach(ctx, `${topic}:observer`, 'observer')
	const detached = h.lifecycle.detach(h.ctx(), `${topic}:observer`, 'observer')
	await new Promise((resolve) => setImmediate(resolve))
	assert.ok(h.grants.has(topic))
	release()
	await Promise.all([attached, detached])
	assert.equal(h.roles.size, 0)
	assert.equal(h.grants.size, 0)
})
