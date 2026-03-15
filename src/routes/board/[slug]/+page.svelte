<!--
	Board page -- the main collaborative canvas.

	This is where all the action happens. Users see a shared canvas with
	sticky notes they can create, drag, edit, delete, and rearrange.
	Other users' cursors appear in real time, and a presence bar shows
	who's currently on the board.

	Data flow:
	- Server sends initial notes/settings/activity via live streams
	- User actions call RPCs (createNote, moveNote, etc) over WebSocket
	- RPCs update the database and publish events
	- All connected clients receive events and update their local state
	- Undo/redo is built into the notes stream (enableHistory)
-->
<script>
	import { batch } from 'svelte-realtime/client'
	import { notes, createNote, moveNote, editNote, deleteNote, focusNote, tidyNotes, rearrangeNotes, shuffleNotes, groupByAuthor } from '$live/boards/notes'
	import { Layers, LayoutGrid, Shuffle, Users, Sparkles, X } from 'lucide-svelte'
	import { activity } from '$live/boards/activity'
	import { settings, updateSettings } from '$live/boards/settings'
	import Canvas from '$lib/components/Canvas.svelte'
	import StickyNote from '$lib/components/StickyNote.svelte'
	import PresenceBar from '$lib/components/PresenceBar.svelte'
	import CursorOverlay from '$lib/components/CursorOverlay.svelte'
	import ActivityTicker from '$lib/components/ActivityTicker.svelte'
	import BoardHeader from '$lib/components/BoardHeader.svelte'

	let { data } = $props()
	const boardId = $derived(data.boardId)

	// --- Live streams ---
	// These are reactive: they update automatically when events arrive
	// from the server. $notesStore is an array of notes, $settingsStore
	// is the board settings object, $activityStore is the activity feed.
	const notesStore = $derived(notes(boardId))
	const settingsStore = $derived(settings(boardId))
	const activityStore = $derived(activity(boardId))

	// Enable undo/redo once the notes stream has loaded.
	// This tracks all created/updated/deleted events so Ctrl+Z works.
	$effect(() => {
		if ($notesStore !== undefined) {
			notesStore.enableHistory()
		}
	})

	const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff']

	// --- Note creation ---
	// Double-click the canvas -> create a note at that position
	function handleCanvasDoubleClick(e) {
		const rect = e.currentTarget.getBoundingClientRect()
		createNote(boardId, {
			content: '',
			x: e.clientX - rect.left,
			y: e.clientY - rect.top,
			color: localStorage.getItem('noteColor') || NOTE_COLORS[0]
		})
	}

	// --- Drag handling ---
	// During a drag, we track positions locally (for instant visual feedback)
	// AND send them to the server (so other users see the movement).
	// batch() groups the moveNote RPC with other pending calls.
	let localPositions = $state({})
	let dragging = $state(false)

	function handleMove(noteId, x, y) {
		if (!dragging) {
			dragging = true
			// Pause undo history during drag -- we don't want every
			// pixel of movement as a separate undo step.
			notesStore.pauseHistory()
		}
		localPositions[noteId] = { x, y }
		batch(() => [moveNote(boardId, noteId, x, y)])
	}

	function handleMoveEnd(noteId) {
		delete localPositions[noteId]
		if (dragging) {
			dragging = false
			// Resume history -- the entire drag is now one undo step.
			notesStore.resumeHistory()
		}
	}

	// Merge local drag positions with server-confirmed positions.
	// During a drag, localPositions overrides the server position
	// for instant feedback. After drag ends, server position takes over.
	const displayNotes = $derived(
		($notesStore ?? []).map(note => {
			const pos = localPositions[note.note_id]
			return pos ? { ...note, x: pos.x, y: pos.y } : note
		})
	)

	// --- Z-ordering ---
	// Clicking a note brings it to the front by setting z_index = max + 1.
	function bringToFront(noteId) {
		const maxZ = Math.max(0, ...($notesStore ?? []).map(n => n.z_index ?? 0))
		focusNote(boardId, noteId, maxZ + 1)
	}

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

	// --- Keyboard shortcuts ---
	// Ctrl+Z = undo, Ctrl+Shift+Z or Ctrl+Y = redo.
	// Disabled when typing in a textarea or input (so browser undo works there).
	function onKeyDown(e) {
		const tag = document.activeElement?.tagName
		if (tag === 'TEXTAREA' || tag === 'INPUT') return
		if (e.key === 'y' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault()
			notesStore.redo()
		} else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault()
			if (e.shiftKey) {
				notesStore.redo()
			} else {
				notesStore.undo()
			}
		}
	}
</script>

<svelte:window onkeydown={onKeyDown} />

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
	<BoardHeader
		settings={$settingsStore}
		onUpdate={(fields) => updateSettings(boardId, fields)}
	>
		<PresenceBar {boardId} />
	</BoardHeader>

	<Canvas
		background={$settingsStore?.background ?? '#f5f5f4'}
		ondblclick={handleCanvasDoubleClick}
		{boardId}
		noteCount={displayNotes.length}
	>
		{#each displayNotes as note (note.note_id)}
			<StickyNote
				{note}
				zIndex={note.z_index ?? 0}
				onMove={(x, y) => handleMove(note.note_id, x, y)}
				onMoveEnd={() => handleMoveEnd(note.note_id)}
				onEdit={(fields) => editNote(boardId, note.note_id, fields)}
				onDelete={() => deleteNote(boardId, note.note_id)}
				onFocus={() => bringToFront(note.note_id)}
			/>
		{/each}

		<CursorOverlay {boardId} userId={data.identity?.id} />
	</Canvas>

	<ActivityTicker items={$activityStore} />

	<!--
		FAB (Floating Action Button) menu for board arrangement actions.
		Uses DaisyUI's fab-flower pattern: focus the trigger button to
		reveal the action buttons. Blur (or click close) to hide them.
	-->
	<div class="fab fab-flower">
		<div tabindex="0" role="button" class="btn btn-lg btn-circle btn-primary fab-trigger">
			<Sparkles size={22} />
		</div>
		<div class="fab-close">
			<button class="btn btn-circle btn-lg btn-error" onclick={() => document.activeElement?.blur()}>
				<X size={20} />
			</button>
		</div>
		<div class="tooltip tooltip-left" data-tip="Tidy z-order">
			<button class="btn btn-lg btn-circle btn-secondary" onclick={() => tidyNotes(boardId)}>
				<Layers size={20} />
			</button>
		</div>
		<div class="tooltip tooltip-left" data-tip="Re-arrange by color">
			<button class="btn btn-lg btn-circle btn-accent" onclick={() => rearrangeNotes(boardId)}>
				<LayoutGrid size={20} />
			</button>
		</div>
		<div class="tooltip" data-tip="Shuffle notes">
			<button class="btn btn-lg btn-circle btn-warning" onclick={() => shuffleNotes(boardId)}>
				<Shuffle size={20} />
			</button>
		</div>
		<div class="tooltip tooltip-top" data-tip="Group by author">
			<button class="btn btn-lg btn-circle btn-info" onclick={() => groupByAuthor(boardId)}>
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

<!-- Rate limit toast -->
{#if rateLimitCountdown > 0}
	<div class="toast toast-top toast-center z-50">
		<div class="alert alert-warning shadow-lg">
			<span>Slow down! Retry in {rateLimitCountdown}s</span>
		</div>
	</div>
{/if}
