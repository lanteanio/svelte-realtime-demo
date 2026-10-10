import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { parseAst } from 'vite'

// Execute the actual component handlers and receipt-loading effect with RPC
// delivery under test control, so network races do not depend on wall clocks.
function page() {
	const source = readFileSync(new URL('../../src/routes/board/[slug]/+page.svelte', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
	const nodes = (/** @type {any} */ (parseAst(source))).body
	const functions = nodes.filter((node) => node.type === 'FunctionDeclaration' && ['handleDelete', 'undoDeletion'].includes(node.id.name))
	const deadline = nodes.find((node) => node.type === 'VariableDeclaration' && node.declarations.some((decl) => decl.id.name === 'localDeadline'))
	const effect = nodes.find((node) => node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' && node.expression.callee.name === '$effect' && source.slice(node.start, node.end).includes('pendingNoteDeletions'))
	assert.ok(deadline && effect && functions.length === 2)
	let time = 1000
	let deliverDelete, deliverList
	const ctx = vm.createContext({
		boardId: 'board', deletions: [], usedReceipts: new Set(), undoBusy: false, noteError: '', clock: time,
		Date: { now: () => time }, setInterval: () => 0, clearInterval: () => {}, $effect: (fn) => fn(),
		deleteNote: () => new Promise((resolve) => { deliverDelete = resolve }),
		pendingNoteDeletions: () => new Promise((resolve) => { deliverList = resolve }),
		undoNoteDeletion: async () => ({})
	})
	Object.defineProperty(ctx, 'latestDeletion', { get: () => ctx.deletions.filter((item) => item.expiresAt > time)[0] })
	vm.runInContext([deadline, ...functions, effect].map((node) => source.slice(node.start, node.end)).join('\n'), ctx)
	return { ctx, deliverDelete: (item) => deliverDelete(item), deliverList: (items) => deliverList(items), advance: (ms) => { time += ms } }
}
const receipt = { token: 'receipt', noteId: 'note', expiresAt: 999_999, remainingMs: 30_000 }

test('delayed delete response does not offer an already consumed receipt again', async () => {
	const p = page()
	const deleting = p.ctx.handleDelete('note')
	p.deliverList([receipt])
	await Promise.resolve()
	await p.ctx.undoDeletion()
	assert.equal(p.ctx.usedReceipts.has(receipt.token), true)
	assert.equal(p.ctx.deletions.length, 0)
	p.deliverDelete(receipt)
	await deleting
	assert.equal(p.ctx.deletions.length, 0)
})

test('receipt deadlines account for response latency on deletion and reload', async () => {
	for (const route of ['delete', 'list']) {
		const p = page()
		const deleting = route === 'delete' ? p.ctx.handleDelete('note') : null
		p.advance(35_000)
		if (deleting) { p.deliverDelete(receipt); await deleting }
		else { p.deliverList([receipt]); await Promise.resolve() }
		assert.equal(p.ctx.deletions[0].expiresAt, 31_000, route)
		assert.equal(p.ctx.latestDeletion, undefined, route)
	}
})

test('delayed reload receipt list does not resurrect an already restored deletion', async () => {
	const p = page()
	const deleting = p.ctx.handleDelete('note')
	p.deliverDelete(receipt)
	await deleting
	await p.ctx.undoDeletion()
	p.deliverList([receipt])
	await Promise.resolve()
	assert.equal(p.ctx.deletions.length, 0)
})
