import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPerFrameRpc } from '../../src/lib/server/rpc-limits.js'

// Paths as the live registry generates them. Written out rather than derived
// so this test states the contract instead of restating the implementation.
const PER_FRAME = [
	// The board, whose paths predate the generated families.
	'boards/notes/moveNote',
	'boards/cursors/moveCursor',
	'boards/cursors/joinBoard',
	// Every pointer event.
	'demos/multiplayer/lounge/__cursor/move',
	'demos/multiplayer/lounge/__cursor/reportViewport',
	'demos/collab-editor/crdtRoom/__cursor/move',
	'demos/collab-editor/offsetRoom/__cursor/move',
	// Every input frame.
	'demos/arena/arena/__smooth/command',
	'demos/arena/arena/__smooth/center',
	'demos/arena/arena/__smooth/sync',
	'demos/arena/arena/__smooth/shoot',
	'demos/shooter/shooter/__smooth/command',
	'demos/shooter/shooter/__smooth/sync',
	// Every keystroke.
	'demos/kanban/kanban/__doc/update',
	'demos/kanban/kanban/__doc/sync',
	'demos/collab-editor/editorDoc/__doc/update'
]

const COUNTED = [
	// A click, and the one generated family that is a spam vector.
	'demos/multiplayer/lounge/__reaction/emit',
	'demos/collab-editor/crdtRoom/__reaction/emit',
	// Stream subscribes: once per room, not per frame.
	'demos/multiplayer/lounge/__cursors',
	'demos/collab-editor/crdtRoom/__cursors',
	'demos/lobbies/lobby/__cursors',
	'demos/chat/chat/__cursors',
	// Ordinary declared actions.
	'demos/multiplayer/lounge/setHeadline',
	'boards/notes/createNote',
	'demos/auctions/auction/placeBid'
]

test('per-frame transport is never charged to the abuse budget', () => {
	for (const path of PER_FRAME) {
		assert.equal(isPerFrameRpc(path), true, `${path} must bypass the limiter`)
	}
})

test('actions and subscribes stay counted', () => {
	for (const path of COUNTED) {
		assert.equal(isPerFrameRpc(path), false, `${path} must remain rate limited`)
	}
})

test('the family match is anchored to whole segments', () => {
	// A room whose name merely starts with a family name must not inherit the
	// exemption, and a bare mention of the word must not either.
	assert.equal(isPerFrameRpc('demos/x/__cursorish/move'), false)
	assert.equal(isPerFrameRpc('demos/x/room/cursor/move'), false)
	assert.equal(isPerFrameRpc('demos/x/__doc'), false)
	assert.equal(isPerFrameRpc(''), false)
	assert.equal(isPerFrameRpc(undefined), false)
})
