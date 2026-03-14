import { live } from 'svelte-realtime/server'

export const activity = live.stream((ctx, boardId) => `board:${boardId}:activity`, async (ctx, boardId) => {
	return []
}, { merge: 'latest', max: 30 })
