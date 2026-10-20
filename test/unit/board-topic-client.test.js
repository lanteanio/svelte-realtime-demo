import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { parseAst } from 'vite'

function component(name) {
	const source = readFileSync(new URL(`../../src/lib/components/${name}.svelte`, import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
	const nodes = (/** @type {any} */ (parseAst(source))).body
	return {
		initializer(variable, context) {
			const declaration = nodes.flatMap((node) => node.type === 'VariableDeclaration' ? node.declarations : []).find((node) => node.id.name === variable)
			assert.ok(declaration, `${name} declares ${variable}`)
			return vm.runInNewContext(`(${source.slice(declaration.init.start, declaration.init.end)})`, { $derived: (value) => value, ...context })
		},
		handler(name, context) {
			const handler = nodes.find((node) => node.type === 'FunctionDeclaration' && node.id.name === name)
			assert.ok(handler)
			const scope = vm.createContext(context)
			vm.runInContext(source.slice(handler.start, handler.end), scope)
			return scope[name]
		}
	}
}

for (const [name, store, plugin] of [['PresenceBar', 'presenceStore', 'presence'], ['CursorOverlay', 'cursorStore', 'cursor']]) {
	test(`${name} opens only the acknowledged canonical topic`, () => {
		const requests = []
		const empty = {}
		const page = component(name)
		const context = { boardId: 'board-id', topic: null, empty, [plugin]: (topic) => { requests.push(topic); return topic } }
		assert.equal(page.initializer(store, context), empty)
		assert.deepEqual(requests, [])
		context.topic = '@t/acme/board:board-id'
		assert.equal(page.initializer(store, context), context.topic)
		assert.deepEqual(requests, [context.topic])
	})
}

test('the cursor overlay tolerates the unacknowledged empty store', () => {
	const cursors = component('CursorOverlay').initializer('cursors', { $cursorStore: undefined, userId: 'self' })
	assert.equal(cursors.length, 0)
})

function canvas() {
	const moves = []
	const context = {
		boardId: 'board-id', topic: null,
		canvasEl: { getBoundingClientRect: () => ({ left: 10, top: 20 }), scrollLeft: 30, scrollTop: 40 },
		moveCursor: (topic, position) => moves.push({ topic, position })
	}
	const fire = component('Canvas').handler('onPointerMove', context)
	return { context, moves, fire: () => fire({ clientX: 110, clientY: 220 }) }
}

test('the board canvas sends nothing before participation is acknowledged', () => {
	const c = canvas()
	c.fire()
	assert.equal(c.moves.length, 0)
})

test('the board canvas sends the current resolved topic through route changes', () => {
	const c = canvas()
	c.context.topic = '@t/acme/board:first'
	c.fire()
	assert.equal(c.moves[0].topic, c.context.topic)
	assert.equal(c.moves[0].position.x, 130)
	assert.equal(c.moves[0].position.y, 240)
	c.context.topic = null
	c.fire()
	assert.equal(c.moves.length, 1)
	c.context.topic = '@t/acme/board:second'
	c.fire()
	assert.equal(c.moves[1].topic, c.context.topic)
})

test('a retained participant topic stays unavailable until a fresh attach is connected', () => {
	const source = readFileSync(new URL('../../src/routes/board/[slug]/+page.svelte', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
	const nodes = (/** @type {any} */ (parseAst(source))).body
	const declaration = nodes.flatMap((node) => node.type === 'VariableDeclaration' ? node.declarations : []).find((node) => node.id.name === 'boardTopic')
	assert.ok(declaration, 'the board page owns an acknowledged topic gate')
	const expression = source.slice(declaration.init.start, declaration.init.end)
	const context = { $derived: (value) => value, participant: { topic: '@t/acme/board:retained' }, $participationStatus: 'loading' }
	for (const status of ['loading', 'reconnecting', 'error']) {
		context.$participationStatus = status
		assert.equal(vm.runInNewContext(expression, context), null, status)
	}
	context.$participationStatus = 'connected'
	assert.equal(vm.runInNewContext(expression, context), context.participant.topic)
})
