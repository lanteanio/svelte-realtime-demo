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

	const notesStore = $derived(notes(boardId))
	const settingsStore = $derived(settings(boardId))
	const activityStore = $derived(activity(boardId))

	$effect(() => {
		if ($notesStore !== undefined) {
			notesStore.enableHistory()
		}
	})

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

	let dragging = $state(false)

	function handleMove(noteId, x, y) {
		if (!dragging) {
			dragging = true
			notesStore.pauseHistory()
		}
		localPositions[noteId] = { x, y }
		batch(() => [moveNote(boardId, noteId, x, y)])
	}

	function handleMoveEnd(noteId) {
		delete localPositions[noteId]
		if (dragging) {
			dragging = false
			notesStore.resumeHistory()
		}
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

	<!-- FAB Flower: Tidy & Re-arrange -->
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

{#if rateLimitCountdown > 0}
	<div class="toast toast-top toast-center z-50">
		<div class="alert alert-warning shadow-lg">
			<span>Slow down! Retry in {rateLimitCountdown}s</span>
		</div>
	</div>
{/if}
