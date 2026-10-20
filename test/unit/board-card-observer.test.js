import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { parseAst } from 'vite'

test('a board card starts its lazy observation before gating the retained topic', () => {
	const source = readFileSync(new URL('../../src/lib/components/BoardCard.svelte', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
	const nodes = (/** @type {any} */ (parseAst(source))).body
	const declaration = nodes.flatMap((node) => node.type === 'VariableDeclaration' ? node.declarations : []).find((node) => node.id.name === 'topic')
	assert.ok(declaration, 'the card owns an acknowledged observation topic')
	const expression = source.slice(declaration.init.start, declaration.init.end)
	let reads = 0
	const context = {
		$derived: (value) => value,
		get observationValue() { reads++; return { topic: '@t/acme/board:retained' } },
		$observationStatus: 'loading'
	}
	for (const status of ['loading', 'reconnecting', 'error']) {
		context.$observationStatus = status
		reads = 0
		assert.equal(vm.runInNewContext(expression, context), null)
		assert.ok(reads > 0, 'the data subscription starts even before connected status')
	}
	context.$observationStatus = 'connected'
	assert.equal(vm.runInNewContext(expression, context), '@t/acme/board:retained')
})
