import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { parseAst } from 'vite'
import { LiveError } from 'svelte-realtime/server'

function uploadHandler() {
	const source = readFileSync(new URL('../../src/live/demos/upload.js', import.meta.url), 'utf8')
	const declaration = (/** @type {any} */ (parseAst(source))).body.find((node) => node.type === 'ExportNamedDeclaration'
		&& node.declaration?.declarations?.[0]?.id.name === 'uploadFile')
	const handler = declaration.declaration.declarations[0].init.arguments[0]
	const calls = { active: 0, stored: [], files: [], published: [] }
	const context = {
		LiveError, Buffer,
		MAX_FILENAME_LEN: 200, MAX_CHUNK_BYTES: 1024, MAX_FILE_BYTES: 4096,
		chunkIdempotency: null, PUSH_EVENT: 'uploaded',
		TOPICS: { demoUploadFiles: 'files', demoUploadStats: 'stats' },
		sha256Hex: (bytes) => createHash('sha256').update(bytes).digest('hex'),
		storeChunk: (hash) => { calls.stored.push(hash); return true },
		beginUpload: () => calls.active++, endUpload: () => calls.active--,
		appendFile: async (file) => { calls.files.push(file); return [] },
		stripHashes: ({ hashes, ...file }) => file,
		statsSnapshot: async () => ({ fileCount: calls.files.length }),
		live: { notify: async () => {} }
	}
	const run = vm.runInNewContext(`(${source.slice(handler.start, handler.end)})`, context)
	const ctx = {
		user: { id: 'visitor', name: 'Visitor' },
		stream: (async function* () { yield Buffer.from('sample') })(),
		publish: (...args) => calls.published.push(args)
	}
	return { run, calls, ctx }
}

test('upload cancellation uses abortSignal and releases the active slot', async () => {
	const h = uploadHandler()
	const controller = new AbortController()
	controller.abort()
	h.ctx.abortSignal = controller.signal
	await assert.rejects(h.run(h.ctx, { filename: 'sample.txt' }), { code: 'CANCELLED' })
	assert.equal(h.calls.active, 0)
	assert.equal(h.calls.stored.length, 0)
	assert.equal(h.calls.files.length, 0)
	assert.equal(h.calls.published.length, 0)
})

test('an active upload completes with only the public abortSignal field', async () => {
	const h = uploadHandler()
	h.ctx.abortSignal = new AbortController().signal
	const file = await h.run(h.ctx, { filename: 'sample.txt' })
	assert.equal(file.totalBytes, 6)
	assert.equal(h.calls.active, 0)
	assert.equal(h.calls.files.length, 1)
	assert.equal(h.calls.stored.length, 1)
})
