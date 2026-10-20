import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { parseAst } from 'vite'

function page() {
	const source = readFileSync(new URL('../../src/routes/demos/shooter/+page.svelte', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
	const nodes = (/** @type {any} */ (parseAst(source))).body
	const handler = nodes.find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'scheduleFire')
	const effect = nodes.find((node) => node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' && node.expression.callee.name === '$effect' && source.slice(node.start, node.end).includes('view.destroy'))
	let serverNow = 1000
	let nextTimer = 0
	const timers = new Map()
	const shots = []
	let dispose
	const context = vm.createContext({
		view: { now: () => serverNow, shoot: (...args) => shots.push(args), destroy() {} },
		lagMs: 300, shotsFired: 0, addFlash() {}, pendingShots: new Set(),
		setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer },
		clearTimeout: (id) => timers.delete(id),
		$effect: (callback) => { dispose = callback() }
	})
	vm.runInContext([handler, effect].map((node) => source.slice(node.start, node.end)).join('\n'), context)
	return {
		context, shots, dispose: () => dispose(),
		advance: (now) => { serverNow = now; for (const callback of [...timers.values()]) callback(); timers.clear() }
	}
}

test('a delayed shot keeps the server-clock instant captured when aimed', () => {
	const p = page()
	p.context.scheduleFire(0.5)
	assert.equal(p.shots.length, 0)
	p.advance(1300)
	assert.equal(p.shots.length, 1)
	assert.equal(p.shots[0][0].angle, 0.5)
	assert.equal(p.shots[0][1]?.rt, 1000)
})

test('leaving the shooter cancels delayed shots before they reach the transport', () => {
	const p = page()
	p.context.scheduleFire(0.5)
	p.context.scheduleFire(1.5)
	p.dispose()
	p.advance(1300)
	assert.equal(p.shots.length, 0)
})
