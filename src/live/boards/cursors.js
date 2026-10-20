// realtime-allow-public -- this anonymous collaborative demo is intentionally public.
/**
 * Managed board presence roles. Each role has its own stream lifetime;
 * both acknowledge the same server-resolved roster and cursor topic.
 */

import { live } from 'svelte-realtime/server'
import { cursor, presence } from '$lib/server/redis'
import { TOPICS } from '$lib/server/topics'
import { getBoard } from '$lib/server/db'
import { validateBoardId } from '$lib/server/validate'
import { createBoardPresenceLifecycle } from '$lib/server/board-presence'

const boardLifecycle = createBoardPresenceLifecycle({ presence, cursor })

/** Observe an existing board's roster without becoming a participant. */
export const observeBoard = live.stream(
	(_ctx, boardId) => `${TOPICS.boardPresence(validateBoardId(boardId))}:observer`,
	(ctx) => boardLifecycle.load(ctx),
	{
		merge: 'set',
		access: async (_ctx, boardId) => Boolean(await getBoard(validateBoardId(boardId))),
		onSubscribe: (ctx, topic) => boardLifecycle.attach(ctx, topic, 'observer'),
		onUnsubscribe: (ctx, topic) => boardLifecycle.detach(ctx, topic, 'observer')
	}
)

/** Participate while the board page is mounted, including reconnects. */
export const participateBoard = live.stream(
	(_ctx, boardId, _retryAttempt = 0) => `${TOPICS.boardPresence(validateBoardId(boardId))}:participant`,
	(ctx) => boardLifecycle.load(ctx),
	{
		merge: 'set',
		classOfService: 'background',
		access: async (_ctx, boardId) => Boolean(await getBoard(validateBoardId(boardId))),
		onSubscribe: (ctx, topic) => boardLifecycle.attach(ctx, topic, 'participant'),
		onUnsubscribe: (ctx, topic) => boardLifecycle.detach(ctx, topic, 'participant')
	}
)
