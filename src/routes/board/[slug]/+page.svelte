<script>
	import { batch } from 'svelte-realtime/client'
	import { notes, createNote, moveNote, editNote, deleteNote, focusNote } from '$live/boards/notes'
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

	const notesStore = $derived(notes(boardId))
	const settingsStore = $derived(settings(boardId))
	const activityStore = $derived(activity(boardId))

	const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff']

	function handleCanvasDoubleClick(e) {
		const rect = e.currentTarget.getBoundingClientRect()
		createNote(boardId, {
			content: '',
			x: e.clientX - rect.left,
			y: e.clientY - rect.top,
			color: localStorage.getItem('noteColor') || NOTE_COLORS[0]
		})
	}

	let localPositions = $state({})

	function handleMove(noteId, x, y) {
		localPositions[noteId] = { x, y }
		batch(() => [moveNote(boardId, noteId, x, y)])
	}

	function handleMoveEnd(noteId) {
		delete localPositions[noteId]
	}

	const displayNotes = $derived(
		($notesStore ?? []).map(note => {
			const pos = localPositions[note.note_id]
			return pos ? { ...note, x: pos.x, y: pos.y } : note
		})
	)

	function bringToFront(noteId) {
		const maxZ = Math.max(0, ...($notesStore ?? []).map(n => n.z_index ?? 0))
		focusNote(boardId, noteId, maxZ + 1)
	}

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

	function onKeyDown(e) {
		if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
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

{#if $notesStore === undefined}
	<div class="flex justify-center items-center h-[80vh]">
		<span class="loading loading-spinner loading-lg"></span>
	</div>
{:else if $notesStore?.error && !$notesStore.error.message?.includes('Retry')}
	<div class="alert alert-error m-4">{$notesStore.error.message}</div>
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
{/if}

{#if rateLimitCountdown > 0}
	<div class="toast toast-top toast-center z-50">
		<div class="alert alert-warning shadow-lg">
			<span>Slow down! Retry in {rateLimitCountdown}s</span>
		</div>
	</div>
{/if}
