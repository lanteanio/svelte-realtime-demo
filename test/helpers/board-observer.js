import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAst } from 'vite'
import { live, LiveError, unsubscribe, close } from 'svelte-realtime/server'
import { validateBoardId } from '../../src/lib/server/validate.js'
import { TOPICS } from '../../src/lib/server/topics.js'
import { createBoardPresenceLifecycle, usesExplicitBoardPresenceLifecycle } from '../../src/lib/server/board-presence.js'
import { isPerFrameRpc } from '../../src/lib/server/rpc-limits.js'

export const BOARD_ID = '12345678-1234-1234-1234-123456789abc'

// Load the real declaration without starting the app's database clients.
export function boardStreams(presence, cursor, getBoard) {
	const source = readFileSync(new URL('../../src/live/boards/cursors.js', import.meta.url), 'utf8')
	const nodes = (/** @type {any} */ (parseAst(source))).body
	const names = nodes.filter((node) => node.type === 'ExportNamedDeclaration')
		.map((node) => node.declaration?.declarations?.[0]?.id.name)
	assert.ok(names.includes('observeBoard') && names.includes('participateBoard'), 'the board has both managed roles')
	const body = nodes.filter((node) => node.type !== 'ImportDeclaration').map((node) => {
		const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node
		return source.slice(declaration.start, declaration.end)
	}).join('\n')
	return new Function('live', 'LiveError', 'TOPICS', 'validateBoardId', 'presence', 'cursor', 'getBoard', 'createBoardPresenceLifecycle',
		`${body}; return { observeBoard, participateBoard }`)(
		live, LiveError, TOPICS, validateBoardId, presence, cursor, getBoard, createBoardPresenceLifecycle)
}

export function boardBeforeExecute(limiter) {
	const source = readFileSync(new URL('../../src/hooks.ws.js', import.meta.url), 'utf8')
	const nodes = (/** @type {any} */ (parseAst(source))).body
	const message = nodes.find((node) => node.type === 'ExportNamedDeclaration'
		&& node.declaration?.declarations?.[0]?.id.name === 'message')?.declaration.declarations[0].init
	const hook = message.arguments[0].properties.find((property) => property.key.name === 'beforeExecute')
	return new Function('limiter', 'isPerFrameRpc', 'LiveError', `return ({${source.slice(hook.start, hook.end)}}).beforeExecute`)(
		limiter, isPerFrameRpc, LiveError)
}

/** Run the actual app adapter hooks without its boot-time infrastructure. */
export function boardHooks(presence, cursor) {
	const source = readFileSync(new URL('../../src/hooks.ws.js', import.meta.url), 'utf8')
	const names = ['subscribe', 'subscribeBatch', 'unsubscribe']
	const nodes = (/** @type {any} */ (parseAst(source))).body
	const bodies = names.map((name) => {
		const declaration = nodes.find((node) => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === name)?.declaration
		assert.ok(declaration, `the app exports ${name}`)
		return source.slice(declaration.start, declaration.end)
	}).join('\n')
	const closeDeclaration = nodes.find((node) => node.type === 'ExportNamedDeclaration'
		&& node.declaration?.declarations?.[0]?.id.name === 'close')?.declaration
	assert.ok(closeDeclaration, 'the app exports its close lifecycle')
	return new Function('presence', 'cursor', 'usesExplicitBoardPresenceLifecycle', 'realtimeUnsubscribe', 'denialFor', 'bestEffort',
		'connectionMetricsHook', 'metrics', 'pushHooks', 'registry', 'chaosOnClose',
		`${bodies}; ${source.slice(closeDeclaration.start, closeDeclaration.end)}; return { subscribe, subscribeBatch, unsubscribe, close }`)(
		presence, cursor, usesExplicitBoardPresenceLifecycle, unsubscribe, () => null, (_label, operation) => {
			const result = operation()
			if (result?.catch) result.catch(() => {})
		}, (_metrics, handler) => handler, {}, { close }, { hooks: { close() {} } }, () => {})
}
