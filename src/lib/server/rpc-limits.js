/**
 * Which RPCs the abuse limiter counts.
 *
 * The limiter exists to stop a client hammering the server, and it counts
 * user ACTIONS: create a note, place a bid, set a headline. A budget of 100
 * per 10 seconds is generous for those and tight enough to be worth having.
 *
 * Per-frame transport is a different thing wearing the same shape. A cursor
 * move fires on every pointer event, a smooth command on every input frame,
 * and a doc update on every keystroke. Counting those spends the whole budget
 * in about a second of ordinary use, so the demo dies while an actual abuser
 * is unaffected - they are lossy, fire-and-forget frames by contract, which
 * is exactly why they are cheap enough not to need a per-call budget.
 *
 * The families are matched by the segment the framework generates for them
 * rather than by listing every path. Listing them individually is what left
 * every demo added after the board exposed to the demo's own limiter: the
 * board's three were named here and `demos/multiplayer/lounge/__cursor/move`,
 * `demos/arena/arena/__smooth/command`, `demos/kanban/kanban/__doc/update`
 * and their siblings were not. A pattern keeps the next one correct without
 * anyone remembering this file.
 *
 * Deliberately still counted:
 * - `__reaction/emit` - a click, and the one generated family that is a spam
 *   vector rather than transport.
 * - stream subscribes (`__cursors`, `__presence`, `__rooms`, ...) - once per
 *   room, not per frame.
 * - every room action a demo declares itself.
 */

/**
 * Board RPCs that predate the generated families and carry no `__` segment.
 * `moveCursor` and `moveNote` fire per pointer frame; `joinBoard` is called
 * on every reconnect during a storm.
 */
const BOARD_PER_FRAME = new Set([
	'boards/notes/moveNote',
	'boards/cursors/moveCursor',
	'boards/cursors/joinBoard'
])

/**
 * Framework-generated per-frame families, matched on the `__`-prefixed
 * segment that names them. Anchored to a full path segment so a room called
 * `__cursorish` cannot match by prefix alone.
 */
const GENERATED_PER_FRAME = /\/__(cursor|smooth|doc)\//

/**
 * True when an RPC carries per-frame transport and must not be charged to the
 * abuse budget.
 *
 * @param {string} rpcPath
 * @returns {boolean}
 */
export function isPerFrameRpc(rpcPath) {
	if (typeof rpcPath !== 'string' || rpcPath === '') return false
	return BOARD_PER_FRAME.has(rpcPath) || GENERATED_PER_FRAME.test(rpcPath)
}
