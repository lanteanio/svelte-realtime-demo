<script>
	import { batch } from 'svelte-realtime/client'
	import { notes, createNote, moveNote, editNote, deleteNote } from '$live/boards/notes'
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

	const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff']

	function handleCanvasDoubleClick(e) {
		const rect = e.currentTarget.getBoundingClientRect()
		createNote(boardId, {
			content: '',
			x: e.clientX - rect.left,
			y: e.clientY - rect.top,
			color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)]
		})
	}

	let localPositions = $state({})

	function handleMove(noteId, x, y) {
		localPositions[noteId] = { x, y }
		batch(() => moveNote(boardId, noteId, x, y))
	}

	function handleMoveEnd(noteId) {
		delete localPositions[noteId]
	}

	const displayNotes = $derived(
		($notes ?? []).map(note => localPositions[note.note_id]
			? { ...note, ...localPositions[note.note_id] }
			: note
		)
	)

	let topZ = $state(1)

	function bringToFront(noteId) {
		localPositions[noteId] = { ...localPositions[noteId], z: ++topZ }
	}

	function onKeyDown(e) {
		if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault()
			if (e.shiftKey) {
				notes.redo()
			} else {
				notes.undo()
			}
		}
	}
</script>

<svelte:window onkeydown={onKeyDown} />

{#if $notes === undefined}
	<div class="flex justify-center items-center h-[80vh]">
		<span class="loading loading-spinner loading-lg"></span>
	</div>
{:else if $notes?.error}
	<div class="alert alert-error m-4">{$notes.error.message}</div>
{:else}
	<BoardHeader
		settings={$settings}
		onUpdate={(fields) => updateSettings(boardId, fields)}
	>
		<PresenceBar {boardId} />
	</BoardHeader>

	<Canvas
		background={$settings?.background ?? '#f5f5f4'}
		ondblclick={handleCanvasDoubleClick}
		{boardId}
		noteCount={displayNotes.length}
	>
		{#each displayNotes as note (note.note_id)}
			<StickyNote
				{note}
				zIndex={localPositions[note.note_id]?.z ?? 1}
				onMove={(x, y) => handleMove(note.note_id, x, y)}
				onMoveEnd={() => handleMoveEnd(note.note_id)}
				onEdit={(fields) => editNote(boardId, note.note_id, fields)}
				onDelete={() => deleteNote(boardId, note.note_id)}
				onFocus={() => bringToFront(note.note_id)}
			/>
		{/each}

		<CursorOverlay {boardId} />
	</Canvas>

	<ActivityTicker items={$activity} />
{/if}
