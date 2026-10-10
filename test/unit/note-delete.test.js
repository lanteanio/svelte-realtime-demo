import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseAst } from 'vite'

async function handlers() {
	let row = { note_id: 'note', board_id: 'board', content: 'Saved', x: 10, y: 20, color: '#fef08a', creator_name: 'Visitor', z_index: 0 }
	const calls = { reads: 0, writes: [], snapshots: [], published: [] }
	let flush
	let removalFails = false
	let updateBehavior
	const receipt = { token: 'receipt', noteId: 'note', expiresAt: Date.now() + 30_000 }
	const live = Object.assign((handler) => handler, {
		idempotent: (_options, handler) => handler,
		lock: (_options, handler) => handler,
		stream: (_topic, handler) => handler,
		cron: (_schedule, _topic, handler) => handler
	})
	class LiveError extends Error { constructor(code, message) { super(message); this.code = code } }
	const deps = {
		live, LiveError,
		listNotes: async () => row ? [row] : [],
		dbGetNote: async () => { calls.reads++; return row ? { ...row } : null },
		dbCreateNote: async () => row,
		dbUpdateNote: async (_id, fields) => {
			calls.writes.push(fields)
			if (updateBehavior) await updateBehavior()
			if (!row) return null
			row = { ...row, ...fields }
			return row
		},
		deleteNoteWithUndo: async (boardId, noteId, actorId) => {
			if (removalFails) throw new Error('Delete failed')
			calls.snapshots.push({ row: { ...row }, boardId, noteId, actorId })
			row = null
			return receipt
		},
		restoreDeletedNote: async () => null,
		listNoteDeletions: async () => [], pruneNoteDeletions: async () => {},
		dbBatchUpdateNotes: async () => [], touchBoard: async () => null,
		TOPICS: { notes: (id) => `notes:${id}`, activity: (id) => `activity:${id}`, settings: (id) => `settings:${id}` },
		acknowledgeNoteFlush: (entry, version, fresh) => { entry.note = { ...fresh, x: entry.note.x, y: entry.note.y }; if (entry.version === version) entry.dirty = false },
		mergeNoteMutation: () => {}, reconcileBatchPosition: () => {}, cascadeColumns: () => [],
		activityEvent: () => ({}),
		setInterval: (callback) => { flush = callback; return { unref() {} } }, clearInterval: () => {}
	}
	for (const name of ['validateBoardId', 'validateNoteId', 'validateNoteContent', 'validateCoord', 'validateNoteColor', 'validateNoteFields', 'validateZIndex']) deps[name] = (value) => value
	let source = readFileSync(new URL('../../src/live/boards/notes.js', import.meta.url), 'utf8')
	for (const item of (/** @type {any} */ (parseAst(source))).body.filter((node) => node.type === 'ImportDeclaration').reverse()) {
		source = source.slice(0, item.start) + source.slice(item.end)
	}
	const key = `noteTest_${crypto.randomUUID()}`
	globalThis[key] = deps
	let module
	try {
		module = await import('data:text/javascript;base64,' + Buffer.from(`const {${Object.keys(deps).join(',')}} = globalThis[${JSON.stringify(key)}]\n${source}`).toString('base64'))
	} finally { delete globalThis[key] }
	return {
		module, calls, receipt, flush: () => flush(),
		failRemove: () => { removalFails = true },
		onUpdate: (fn) => { updateBehavior = fn },
		ctx: { user: { id: 'actor', name: 'Visitor' }, shed: () => false, publish: (...args) => calls.published.push(args) }
	}
}

test('deletion snapshots the latest buffered position before publishing and returning its receipt', async () => {
	const h = await handlers()
	await h.module.moveNote(h.ctx, 'board', 'note', 410, 320)
	assert.equal(await h.module.deleteNote(h.ctx, 'board', 'note'), h.receipt)
	assert.equal(h.calls.snapshots[0].row.x, 410)
	assert.equal(h.calls.snapshots[0].row.y, 320)
	assert.equal(h.calls.snapshots[0].actorId, 'actor')
	assert.ok(h.calls.published.some(([topic, event]) => topic === 'notes:board' && event === 'deleted'))
	const writes = h.calls.writes.length
	await h.flush()
	assert.equal(h.calls.writes.length, writes, 'a deleted cache entry must not flush again')
})

test('a failed deletion leaves the buffered entry available for subsequent movement and flush', async () => {
	const h = await handlers()
	await h.module.moveNote(h.ctx, 'board', 'note', 410, 320)
	h.failRemove()
	await assert.rejects(h.module.deleteNote(h.ctx, 'board', 'note'), /Delete failed/)
	assert.equal(h.calls.published.some(([, event]) => event === 'deleted'), false)
	const reads = h.calls.reads
	await h.module.moveNote(h.ctx, 'board', 'note', 500, 360)
	assert.equal(h.calls.reads, reads, 'failed deletion must restore the detached cache entry')
	await h.flush()
	assert.deepEqual(h.calls.writes.at(-1), { x: 500, y: 360 })
})

test('deletion waits for an in-flight position write before snapshotting', async () => {
	const h = await handlers()
	/** @type {() => void} */
	let finish = () => { throw new Error('position write did not start') }
	h.onUpdate(() => new Promise((resolve) => { finish = () => resolve(undefined) }))
	await h.module.moveNote(h.ctx, 'board', 'note', 410, 320)
	const flushing = h.flush()
	const deleting = h.module.deleteNote(h.ctx, 'board', 'note')
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(h.calls.snapshots.length, 0)
	h.onUpdate(null)
	finish()
	await flushing
	await deleting
	assert.equal(h.calls.snapshots[0].row.x, 410)
})
