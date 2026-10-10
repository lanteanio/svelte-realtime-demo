/** A deletion can be compensated once, by its actor, for thirty seconds. */
export const NOTE_UNDO_MS = 30_000

function publicNote(note) {
	const { note_id, board_id, content, x, y, color, creator_name, z_index } = note
	return { note_id, board_id, content, x, y, color, creator_name, z_index: z_index ?? 0 }
}

function receipt(row) {
	return { token: row.receipt_id, noteId: row.note_id, expiresAt: Number(row.expires_at), remainingMs: Math.max(0, Number(row.remaining_ms)) }
}

export function postgresNoteUndo(pool) {
	return {
		async remove(boardId, noteId, actorId) {
			// One statement: a failed receipt insert rolls the deletion back too.
			// Lock the parent before its child, like a cascading board deletion.
			// KEY SHARE still allows unrelated notes on this board to change.
			const { rows } = await pool.query(`
				WITH locked_board AS MATERIALIZED (
					SELECT board_id FROM board WHERE board_id = $2 FOR KEY SHARE
				), removed AS (
					DELETE FROM note USING locked_board
					WHERE note.note_id = $1 AND note.board_id = locked_board.board_id
					RETURNING note.*
				)
				INSERT INTO note_deletion (board_id, actor_id, note_id, snapshot)
				SELECT board_id, $3, note_id, to_jsonb(removed) FROM removed
				RETURNING receipt_id, note_id, extract(epoch FROM expires_at) * 1000 AS expires_at,
				          extract(epoch FROM (expires_at - clock_timestamp())) * 1000 AS remaining_ms
			`, [noteId, boardId, actorId])
			return rows[0] ? receipt(rows[0]) : null
		},
		async list(boardId, actorId) {
			const { rows } = await pool.query(`
				SELECT receipt_id, note_id, extract(epoch FROM expires_at) * 1000 AS expires_at,
				          extract(epoch FROM (expires_at - clock_timestamp())) * 1000 AS remaining_ms
				FROM note_deletion
				WHERE board_id = $1 AND actor_id = $2 AND expires_at > clock_timestamp()
				ORDER BY expires_at DESC
			`, [boardId, actorId])
			return rows.map(receipt)
		},
		async restore(boardId, token, actorId) {
			// Concurrent requests compete for one receipt. An existing note wins
			// over a snapshot; consuming a conflicting receipt prevents a later
			// deletion from making that obsolete snapshot usable again.
			// Acquire the board lock before the receipt to match cascade order.
			const { rows } = await pool.query(`
				WITH locked_board AS MATERIALIZED (
					SELECT board_id FROM board WHERE board_id = $2 FOR KEY SHARE
				), consumed AS (
					DELETE FROM note_deletion USING locked_board
					WHERE receipt_id = $1 AND note_deletion.board_id = locked_board.board_id AND actor_id = $3
					AND expires_at > clock_timestamp()
					RETURNING snapshot
				)
				INSERT INTO note (note_id, board_id, content, x, y, color, creator_name, z_index, is_archived, created_at)
				SELECT n.note_id, n.board_id, n.content, n.x, n.y, n.color, n.creator_name,
				       n.z_index, n.is_archived, n.created_at
				FROM consumed, jsonb_populate_record(NULL::note, consumed.snapshot) AS n
				ON CONFLICT (note_id) DO NOTHING
				RETURNING note_id, board_id, content, x, y, color, creator_name, z_index
			`, [token, boardId, actorId])
			return rows[0] ?? null
		},
		async prune() {
			await pool.query('DELETE FROM note_deletion WHERE expires_at <= clock_timestamp()')
		}
	}
}

export function memoryNoteUndo(boards, notes, now = Date.now) {
	const receipts = new Map()
	const prune = () => {
		for (const [token, item] of receipts) {
			if (item.expiresAt <= now() || !boards.has(item.boardId)) receipts.delete(token)
		}
	}
	return {
		remove(boardId, noteId, actorId) {
			prune()
			const note = notes.get(noteId)
			if (!note || note.board_id !== boardId || !boards.has(boardId)) return null
			const token = crypto.randomUUID()
			const expiresAt = now() + NOTE_UNDO_MS
			receipts.set(token, { boardId, actorId, note: structuredClone(note), expiresAt })
			notes.delete(noteId)
			return { token, noteId, expiresAt, remainingMs: NOTE_UNDO_MS }
		},
		list(boardId, actorId) {
			prune()
			return [...receipts].reverse().filter(([, item]) => item.boardId === boardId && item.actorId === actorId)
				.map(([token, item]) => ({ token, noteId: item.note.note_id, expiresAt: item.expiresAt, remainingMs: Math.max(0, item.expiresAt - now()) }))
				.sort((a, b) => b.expiresAt - a.expiresAt)
		},
		restore(boardId, token, actorId) {
			prune()
			const item = receipts.get(token)
			if (!item || item.boardId !== boardId || item.actorId !== actorId) return null
			receipts.delete(token)
			if (notes.has(item.note.note_id)) return null
			notes.set(item.note.note_id, structuredClone(item.note))
			return publicNote(item.note)
		},
		prune
	}
}
