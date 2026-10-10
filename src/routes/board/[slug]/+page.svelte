<!--
	Board page - the main collaborative canvas.

	This is where all the action happens. Users see a shared canvas with
	sticky notes they can create, drag, edit, delete, and rearrange.
	Other users' cursors appear in real time, and a presence bar shows
	who's currently on the board.

	Data flow:
	- Server sends initial notes/settings/activity via live streams
	- User actions call RPCs (createNote, moveNote, etc) over WebSocket
	- RPCs update the database and publish events
	- All connected clients receive events and update their local state

	Deleting a note creates a short-lived server receipt owned by this visitor.
	Undo restores that snapshot through an RPC and publishes it to everyone.
-->
<script>
	import { notes, createNote, moveNote, editNote, deleteNote, pendingNoteDeletions, undoNoteDeletion, focusNote, tidyNotes, rearrangeNotes, shuffleNotes, groupByAuthor } from '$live/boards/notes'
	import { Layers, LayoutGrid, Shuffle, Users, Sparkles, X } from 'lucide-svelte'
	import { activity } from '$live/boards/activity'
	import { settings, updateSettings } from '$live/boards/settings'
	import Canvas from '$lib/components/Canvas.svelte'
	import StickyNote from '$lib/components/StickyNote.svelte'
	import PresenceBar from '$lib/components/PresenceBar.svelte'
	import CursorOverlay from '$lib/components/CursorOverlay.svelte'
	import ActivityTicker from '$lib/components/ActivityTicker.svelte'
	import BoardHeader from '$lib/components/BoardHeader.svelte'
	import { isBoardUndoShortcut, startUndoCountdown } from '$lib/client/board-undo'

	let { data } = $props()
	const boardId = $derived(data.boardId)

	// --- Live streams ---
	// These are reactive: they update automatically when events arrive
	// from the server. $notesStore is an array of notes, $settingsStore
	// is the board settings object, $activityStore is the activity feed.
	const notesStore = $derived(notes(boardId))
	const settingsStore = $derived(settings(boardId))
	const activityStore = $derived(activity(boardId))

	const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff']

	// --- Note creation ---
	// Double-click the canvas -> create a note at that position.
	// Account for scroll offset so notes land where you clicked,
	// not where the viewport thinks you clicked.
	function handleCanvasDoubleClick(e) {
		const canvas = e.currentTarget
		const rect = canvas.getBoundingClientRect()
		// idempotencyKey: a flaky-reconnect retry on this exact intent
		// returns the same note instead of creating duplicates.
		const idempotencyKey = crypto.randomUUID()
		createNote.with({ idempotencyKey })(boardId, {
			content: '',
			x: e.clientX - rect.left + canvas.scrollLeft,
			y: e.clientY - rect.top + canvas.scrollTop,
			color: localStorage.getItem('noteColor') || NOTE_COLORS[0]
		})
	}

	// Header "+ Note": the keyboard/touch route to creation. Lands in the
	// upper-left region with a small scatter so repeated presses don't stack
	// notes into one invisible pile.
	function handleAddNote() {
		const idempotencyKey = crypto.randomUUID()
		createNote.with({ idempotencyKey })(boardId, {
			content: '',
			x: 100 + Math.floor(Math.random() * 160),
			y: 120 + Math.floor(Math.random() * 120),
			color: localStorage.getItem('noteColor') || NOTE_COLORS[0]
		})
	}

	// Receipts come from the server, including after navigation or reload.
	let deletions = $state([])
	let usedReceipts = new Set()
	const localDeadline = (item, requestedAt) => ({ ...item, expiresAt: requestedAt + item.remainingMs })
	let undoBusy = $state(false)
	let noteError = $state('')
	let clock = $state(Date.now())
	const undoable = $derived(deletions.filter((item) => item.expiresAt > clock))
	const latestDeletion = $derived(undoable[0])

	$effect(() => {
		const currentBoard = boardId
		let active = true
		deletions = []
		usedReceipts = new Set()
		const requestedAt = Date.now()
		pendingNoteDeletions(currentBoard).then((items) => {
			if (active) deletions = [...deletions, ...items.filter((item) => !usedReceipts.has(item.token) && !deletions.some((own) => own.token === item.token)).map((item) => localDeadline(item, requestedAt))]
		}).catch((error) => { if (active) noteError = error?.message ?? 'Could not load recent deletions' })
		return () => { active = false }
	})

	$effect(() => startUndoCountdown(deletions.map((item) => item.expiresAt), (now) => { clock = now }))

	$effect(() => {
		if (!noteError) return
		const timer = setTimeout(() => { noteError = '' }, 6000)
		return () => clearTimeout(timer)
	})

	async function handleDelete(noteId) {
		const currentBoard = boardId
		const requestedAt = Date.now()
		noteError = ''
		try {
			const receipt = await deleteNote(currentBoard, noteId)
			if (currentBoard === boardId && !usedReceipts.has(receipt.token)) deletions = [localDeadline(receipt, requestedAt), ...deletions.filter((item) => item.token !== receipt.token)]
		} catch (error) {
			if (currentBoard === boardId) noteError = error?.message ?? 'Could not delete the note'
		}
	}

	async function undoDeletion() {
		if (!latestDeletion || undoBusy) return
		const { token } = latestDeletion
		const currentBoard = boardId
		undoBusy = true
		noteError = ''
		try {
			await undoNoteDeletion(currentBoard, token)
			if (currentBoard === boardId) {
				usedReceipts.add(token)
				deletions = deletions.filter((item) => item.token !== token)
			}
		} catch (error) {
			if (currentBoard === boardId) {
				noteError = error?.message ?? 'Could not undo the deletion'
				if (error?.code === 'CONFLICT') {
					usedReceipts.add(token)
					deletions = deletions.filter((item) => item.token !== token)
				}
			}
		} finally { undoBusy = false }
	}

	function handleUndoKey(event) {
		if (!latestDeletion || undoBusy || !isBoardUndoShortcut(event)) return
		event.preventDefault()
		void undoDeletion()
	}

	// --- Drag handling ---
	// store.mutate applies the optimistic position to the displayed value
	// immediately and queues the server roundtrip. The server's confirming
	// 'updated' event absorbs the queue entry by note_id (crud merge), so
	// no manual snap-back protection or local-position bookkeeping needed.
	function handleMove(noteId, x, y) {
		notesStore.mutate(
			() => moveNote(boardId, noteId, x, y),
			(current) => current.map(n => n.note_id === noteId ? { ...n, x, y } : n)
		)
	}

	// --- Z-ordering ---
	// Clicking a note brings it to the front by setting z_index = max + 1.
	function bringToFront(noteId) {
		const maxZ = Math.max(0, ...($notesStore ?? []).map(n => n.z_index ?? 0))
		focusNote(boardId, noteId, maxZ + 1)
	}

	// --- Arrangement feedback ---
	// The FAB actions rewrite every note in one call. A failure is shown
	// rather than left as an unhandled rejection only the console sees. A
	// fresh object per failure restarts the timer when the message repeats.
	let arrangeError = $state(/** @type {{ message: string } | null} */ (null))

	async function arrange(action) {
		try {
			await action(boardId)
		} catch (err) {
			arrangeError = { message: err?.message ?? String(err) }
		}
	}

	$effect(() => {
		if (!arrangeError) return
		const timer = setTimeout(() => { arrangeError = null }, 6000)
		return () => clearTimeout(timer)
	})

	// --- Rate limit feedback ---
	// If the user sends too many requests, the server returns a
	// RATE_LIMITED error with a countdown. We show a toast with the
	// remaining seconds.
	let rateLimitCountdown = $state(0)

	$effect(() => {
		const msg = $notesStore?.error?.message
		if (!msg) return
		const match = msg.match(/Retry in (\d+)s/)
		if (!match) return
		rateLimitCountdown = parseInt(match[1])
		const timer = setInterval(() => {
			rateLimitCountdown--
			if (rateLimitCountdown <= 0) clearInterval(timer)
		}, 1000)
		return () => clearInterval(timer)
	})

</script>

<svelte:window onkeydown={handleUndoKey} />

<!-- Loading state: notes stream hasn't returned data yet -->
{#if $notesStore === undefined}
	<div class="flex justify-center items-center h-[80vh]">
		<span class="loading loading-spinner loading-lg"></span>
	</div>
<!-- Error state: something went wrong (but not rate limiting) -->
{:else if $notesStore?.error && !$notesStore.error.message?.includes('Retry')}
	<div class="alert alert-error m-4">{$notesStore.error.message}</div>
<!-- Normal state: board is loaded -->
{:else}
	<div class="flex min-h-0 flex-1 flex-col" data-testid="board-workspace">
	<BoardHeader
		settings={$settingsStore}
		onUpdate={(fields) => updateSettings(boardId, fields)}
		onAddNote={handleAddNote}
	>
		<PresenceBar {boardId} />
	</BoardHeader>
	<p class="px-3 py-1 text-xs opacity-70" data-testid="board-undo-help">
		Undo your note deletions for 30 seconds, including after reloading (Ctrl/Cmd+Z outside text fields).
		Creating, editing, moving and arranging notes are not undone. No redo.
	</p>

	<Canvas
		background={$settingsStore?.background ?? '#f5f5f4'}
		ondblclick={handleCanvasDoubleClick}
		{boardId}
		noteCount={$notesStore?.length ?? 0}
	>
		{#each $notesStore ?? [] as note (note.note_id)}
			<StickyNote
				{note}
				zIndex={note.z_index ?? 0}
				onMove={(x, y) => handleMove(note.note_id, x, y)}
				onEdit={(fields) => editNote(boardId, note.note_id, fields)}
				onDelete={() => handleDelete(note.note_id)}
				onFocus={() => bringToFront(note.note_id)}
			/>
		{/each}

		<CursorOverlay {boardId} userId={data.identity?.id} />
	</Canvas>

	<ActivityTicker items={$activityStore} />
	</div>

	<!--
		FAB (Floating Action Button) menu for board arrangement actions.
		Uses DaisyUI's fab-flower pattern: focus the trigger button to
		reveal the action buttons. Blur (or click close) to hide them.
	-->
	<div class="fab fab-flower">
		<div tabindex="0" role="button" class="btn btn-lg btn-circle btn-primary fab-trigger tooltip tooltip-left" data-tip="Arrange board" aria-label="Arrange board">
			<Sparkles size={22} />
		</div>
		<div class="fab-close">
			<button class="btn btn-circle btn-lg btn-error" onclick={() => document.activeElement?.blur()}>
				<X size={20} />
			</button>
		</div>
		<div class="tooltip tooltip-left" data-tip="Tidy z-order">
			<button class="btn btn-lg btn-circle btn-secondary" onclick={() => arrange(tidyNotes)}>
				<Layers size={20} />
			</button>
		</div>
		<div class="tooltip tooltip-left" data-tip="Re-arrange by color">
			<button class="btn btn-lg btn-circle btn-accent" onclick={() => arrange(rearrangeNotes)}>
				<LayoutGrid size={20} />
			</button>
		</div>
		<div class="tooltip" data-tip="Shuffle notes">
			<button class="btn btn-lg btn-circle btn-neutral" onclick={() => arrange(shuffleNotes)}>
				<Shuffle size={20} />
			</button>
		</div>
		<div class="tooltip tooltip-top" data-tip="Group by author">
			<button class="btn btn-lg btn-circle btn-info" onclick={() => arrange(groupByAuthor)}>
				<Users size={20} />
			</button>
		</div>
	</div>
{/if}

<style>
	/* FAB hover/press animations */
	.fab-trigger {
		transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.3s ease, rotate 0.3s ease;
	}
	.fab-trigger:hover {
		transform: scale(1.12) rotate(15deg);
		box-shadow: 0 0 16px rgba(99, 102, 241, 0.5);
	}
	.fab-trigger:active {
		transform: scale(0.92) rotate(-10deg);
	}
	/* Action buttons are hidden by default, shown when FAB has focus */
	.fab .fab-close button {
		transition: opacity 0.3s ease, scale 0.3s ease;
		opacity: 0;
		scale: 0.6;
	}
	.fab:focus-within .fab-close button {
		opacity: 1;
		scale: 1;
	}
</style>

<!-- Arrangement failure toast -->
{#if arrangeError}
	<div class="toast toast-top toast-center z-50" data-testid="arrange-error">
		<div class="alert alert-error shadow-lg" role="alert">
			<span>Could not arrange the board: {arrangeError.message}</span>
		</div>
	</div>
{/if}

<!-- Rate limit toast -->
{#if rateLimitCountdown > 0}
	<div class="toast toast-top toast-center z-50">
		<div class="alert alert-warning shadow-lg">
			<span>Slow down! Retry in {rateLimitCountdown}s</span>
		</div>
	</div>
{/if}

{#if latestDeletion || noteError}
	<div class="toast toast-bottom toast-center z-50" data-testid="board-undo-toast">
		<div class="alert shadow-lg">
			<span role="status">{noteError || 'Note deleted.'}</span>
			{#if latestDeletion}
				<span>Undo available for {Math.max(0, Math.ceil((latestDeletion.expiresAt - clock) / 1000))}s.</span>
				<button class="btn btn-sm" data-testid="board-undo" disabled={undoBusy} onclick={undoDeletion}>Undo</button>
			{/if}
		</div>
	</div>
{/if}
