import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { parseAst } from 'vite'

test('hit feedback forwards the owner rewind without replacing its clock', () => {
	const source = readFileSync(new URL('../../src/live/demos/shooter.js', import.meta.url), 'utf8')
	const nodes = (/** @type {any} */ (parseAst(source))).body
	const definition = nodes.find((node) => node.type === 'ExportNamedDeclaration' && node.declaration?.declarations?.[0]?.id.name === 'shooter')
	const config = definition.declaration.declarations[0].init.arguments[0]
	const hitTest = config.properties.find((property) => property.key.name === 'hitTest').value
	const handler = hitTest.properties.find((property) => property.key.name === 'onHit').value
	const onHit = vm.runInNewContext(`(${source.slice(handler.start, handler.end)})`)
	const events = []
	const ctx = { identity: 'visitor', applyTo() {}, emitEvent: (type, data) => events.push({ type, data }) }
	onHit(ctx, { key: 'target' }, { point: { x: 12, y: 34 }, rewindAt: 8700, rewindMs: 312.75 })
	assert.equal(events.length, 1)
	assert.equal(events[0].type, 'hit')
	assert.equal(events[0].data.rewindMs, 312.75)
})
