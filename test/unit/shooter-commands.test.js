import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { apply, spawnFor, MAX_STEP } from '../../src/live/demos/shooter.shared.js'

const fixture = new URL('../fixtures/handler-boundaries.js', import.meta.url).href
const aliases = { 'svelte-realtime/server': fixture, '$lib/server/topics': new URL('../../src/lib/server/topics.js', import.meta.url).href }
const hooks = registerHooks({ resolve(specifier, context, next) {
	return aliases[specifier] ? { url: aliases[specifier], shortCircuit: true } : next(specifier, context)
} })
/** @type {any} Registration is stubbed to capture the declaration. */
let shooter
try { ({ shooter } = await import('../../src/live/demos/shooter.js')) }
finally { hooks.deregister() }

test('the registered shooter validates movement and rejects server-authored client commands', () => {
	const decode = shooter.wire.command.unpack
	assert.deepEqual(decode({ type: 'move', dx: MAX_STEP, dy: -MAX_STEP }), { type: 'move', dx: MAX_STEP, dy: -MAX_STEP })
	for (const command of [null, [], {}, { type: 'damage' }, { type: 'score' },
		{ type: 'move', dx: MAX_STEP + 1, dy: 0 }, { type: 'move', dx: Infinity, dy: 0 },
		{ type: 'move', dx: NaN, dy: 0 }, { type: 'move', dx: '1', dy: 0 },
		{ type: 'move', dx: 1, dy: 0, score: 100 }, { angle: 0, hp: 0 }]) {
		assert.throws(() => decode(command), TypeError)
	}
})

test('shot angles remain valid and authoritative hit processing still changes health and score', () => {
	const decode = shooter.wire.command.unpack
	for (const angle of [-Math.PI, 0, Math.PI]) assert.deepEqual(decode({ angle }), { angle })
	for (const angle of [NaN, Infinity, Math.PI + 1, '0']) assert.throws(() => decode({ angle }), TypeError)
	const states = new Map([['target', spawnFor('target')], ['player', spawnFor('player')]])
	const simulation = { rng: { float: () => 0.5 } }
	shooter.hitTest.onHit({
		identity: 'player',
		applyTo(key, command) { states.set(key, apply(states.get(key), command, simulation)) },
		emitEvent() {}
	}, { key: 'target' }, { point: { x: 1, y: 2 } })
	assert.equal(states.get('target').hp, 2)
	assert.equal(states.get('player').score, 1)
})
