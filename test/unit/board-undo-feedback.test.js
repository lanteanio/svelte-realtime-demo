import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { parseAst } from 'vite'
import { parse } from 'svelte/compiler'
import { startUndoCountdown } from '../../src/lib/client/board-undo.js'

const page = readFileSync(new URL('../../src/routes/board/[slug]/+page.svelte', import.meta.url), 'utf8')
const script = page.match(/<script>([\s\S]*?)<\/script>/)[1]
const nodes = (/** @type {any} */ (parseAst(script))).body
const effects = nodes.filter((node) => node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' && node.expression.callee.name === '$effect')

test('only the undo countdown callback writes the page clock', () => {
	const writes = []
	const countdowns = []
	function containsClock(node) {
		if (!node || typeof node !== 'object') return false
		if (node.type === 'Identifier') return node.name === 'clock'
		return Object.values(node).some(value => Array.isArray(value)
			? value.some(containsClock) : containsClock(value))
	}
	function walk(node) {
		if (!node || typeof node !== 'object') return
		if ((node.type === 'AssignmentExpression' && containsClock(node.left))
			|| (node.type === 'UpdateExpression' && containsClock(node.argument))) writes.push(node)
		if (node.type === 'CallExpression' && node.callee.name === 'startUndoCountdown') countdowns.push(node)
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) value.forEach(walk)
			else walk(value)
		}
	}
	nodes.forEach(walk)
	assert.equal(countdowns.length, 1)
	const callback = countdowns[0].arguments[1]
	assert.equal(callback.type, 'ArrowFunctionExpression')
	assert.equal(writes.length, 1, 'Only the deadline-bound countdown callback may write clock')
	assert.equal(writes[0], callback.body.body[0].expression,
		'Clock updates must belong directly to the deadline-bound countdown callback')
})

test('undo countdown is idle without a live deadline and stops exactly at the last expiry', (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
	for (const deadlines of [[], [900]]) {
		const updates = []
		const stop = startUndoCountdown(deadlines, (now) => updates.push(now))
		assert.equal(updates.length, 1)
		t.mock.timers.tick(1000)
		assert.equal(updates.length, 1)
		stop()
	}
	const now = Date.now()
	const updates = []
	startUndoCountdown([now + 250, now + 510], (value) => updates.push(value))
	t.mock.timers.tick(250)
	t.mock.timers.tick(250)
	t.mock.timers.tick(10)
	assert.deepEqual(updates, [now, now + 250, now + 500, now + 510])
	t.mock.timers.tick(10_000)
	assert.equal(updates.length, 4)
})

test('disposing or replacing undo deadlines cancels the previous countdown', (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
	const old = []
	const stop = startUndoCountdown([2000], (now) => old.push(now))
	stop()
	const next = []
	const cleanup = startUndoCountdown([1200], (now) => next.push(now))
	t.mock.timers.tick(200)
	assert.deepEqual(old, [1000])
	assert.deepEqual(next, [1000, 1200])
	cleanup()
	t.mock.timers.tick(1000)
	assert.deepEqual(old, [1000])
	assert.deepEqual(next, [1000, 1200])
})

test('actual undo feedback effects bound errors and return timer cleanup', () => {
	const errorEffect = effects.find((node) => script.slice(node.start, node.end).includes('if (!noteError)'))
	const clockEffect = effects.find((node) => script.slice(node.start, node.end).includes('startUndoCountdown'))
	assert.ok(errorEffect && clockEffect)
	/** @type {() => any} */
	let run = () => undefined
	/** @type {any} */
	let timer
	let cleared
	const ctx = vm.createContext({
		noteError: '', deletions: [{ expiresAt: 5000 }], clock: 0,
		$effect: (fn) => { run = fn },
		setTimeout: (fn, delay) => { timer = { fn, delay }; return timer },
		clearTimeout: (handle) => { cleared = handle },
		startUndoCountdown: (deadlines, update) => {
			assert.equal(JSON.stringify(deadlines), '[5000]')
			update(1234)
			return 'countdown-cleanup'
		}
	})
	vm.runInContext(script.slice(errorEffect.start, errorEffect.end), ctx)
	assert.equal(run(), undefined)
	assert.equal(timer, undefined)
	ctx.noteError = 'Could not undo the deletion'
	const cleanup = run()
	assert.equal(timer.delay, 6000)
	timer.fn()
	assert.equal(ctx.noteError, '')
	cleanup()
	assert.equal(cleared, timer)
	vm.runInContext(script.slice(clockEffect.start, clockEffect.end), ctx)
	assert.equal(run(), 'countdown-cleanup')
	assert.equal(ctx.clock, 1234)
})

test('undo countdown text stays outside the persistent announcement region', () => {
	const ast = parse(page, { modern: true })
	let foundToast = false, foundStatus = false, foundCountdown = false, foundAnnouncementText = false
	function walk(node, inToast = false, live = false, conditional = false, announcement = false) {
		if (!node || typeof node !== 'object') return
		const attrs = node.attributes ?? []
		const attribute = (name) => attrs.find((attr) => attr.type === 'Attribute' && attr.name === name)?.value
		const text = (value) => Array.isArray(value) ? value.map((item) => item.data ?? '').join('') : ''
		conditional ||= ['IfBlock', 'EachBlock', 'AwaitBlock', 'KeyBlock'].includes(node.type)
		inToast ||= text(attribute('data-testid')) === 'board-undo-toast'
		if (text(attribute('data-testid')) === 'board-note-announcement') {
			foundStatus = true
			announcement = true
			assert.equal(text(attribute('role')), 'status')
			assert.equal(conditional, false, 'The announcement region must remain mounted outside conditional blocks')
			assert.equal(inToast, false, 'The announcement region must outlive the toast')
		}
		if (announcement && node.type === 'ExpressionTag' && node.expression?.name === 'noteAnnouncement') foundAnnouncementText = true
		live ||= ['status', 'alert', 'log'].includes(text(attribute('role'))) || ['polite', 'assertive'].includes(text(attribute('aria-live')))
		if (inToast) {
			foundToast = true
			if (node.type === 'ExpressionTag' && page.slice(node.start, node.end).includes('latestDeletion.expiresAt - clock')) {
				foundCountdown = true
				assert.equal(live, false, 'The changing countdown must not be inside a live region')
			}
		}
		for (const [key, value] of Object.entries(node)) {
			if (key === 'parent' || key === 'loc') continue
			if (Array.isArray(value)) value.forEach((child) => walk(child, inToast, live, conditional, announcement))
			else if (value && typeof value === 'object') walk(value, inToast, live, conditional, announcement)
		}
	}
	walk(ast.fragment)
	assert.ok(foundToast && foundStatus && foundCountdown && foundAnnouncementText)
})
