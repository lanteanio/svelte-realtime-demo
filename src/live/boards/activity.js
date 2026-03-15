/**
 * Activity feed -- live stream only (no RPCs).
 *
 * Activity events are ephemeral -- they're not stored in the database.
 * The initial data is always an empty array. Events arrive via pub/sub
 * as users perform actions on the board.
 *
 * merge: 'latest' keeps only the most recent N items (max: 30).
 * The ActivityTicker component shows the 5 newest entries.
 */

import { live } from 'svelte-realtime/server'

export const activity = live.stream((ctx, boardId) => `board:${boardId}:activity`, async (ctx, boardId) => {
	return []
}, { merge: 'latest', max: 30 })
