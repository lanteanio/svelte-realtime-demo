import { live } from 'svelte-realtime/server'

export const activity = live.stream('board-activity', async () => {
	return []
}, { merge: 'latest', max: 30 })
