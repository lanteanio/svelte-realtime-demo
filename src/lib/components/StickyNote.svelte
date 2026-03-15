<!--
	StickyNote -- a draggable, editable sticky note card.

	Interaction model:
	- Click: brings to front (z-index)
	- Drag: moves the note (pointer capture for smooth dragging)
	- Double-click: enters edit mode (shows textarea)
	- Escape or blur: exits edit mode and saves
	- Hover: shows delete (X) and color picker (palette) buttons

	The note doesn't own its data -- it receives everything via props
	and calls parent callbacks (onMove, onEdit, onDelete, onFocus) to
	request changes. The parent then sends RPCs to the server, which
	publishes events to all connected clients.
-->
<script>
	import { Palette, X } from 'lucide-svelte'
	let { note, zIndex = 1, onMove, onMoveEnd, onEdit, onDelete, onFocus } = $props()
	let dragging = $state(false)
	let editing = $state(false)
	let showColors = $state(false)
	let offset = $state({ x: 0, y: 0 })

	const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff']

	// --- Drag handling ---
	// Uses pointer capture so the note keeps receiving events even if
	// the cursor moves outside the element (fast dragging).

	function onPointerDown(e) {
		if (editing) return
		onFocus()
		dragging = true
		offset = { x: e.clientX - note.x, y: e.clientY - note.y }
		e.currentTarget.setPointerCapture(e.pointerId)
	}

	function onPointerMove(e) {
		if (!dragging) return
		onMove(e.clientX - offset.x, e.clientY - offset.y)
	}

	function onPointerUp() {
		if (dragging) {
			dragging = false
			onMoveEnd()
		}
	}

	// --- Edit handling ---

	function startEditing() {
		editing = true
	}

	function stopEditing(e) {
		editing = false
		onEdit({ content: e.target.value })
	}

	/** Prevent drag start when clicking buttons inside the note. */
	function stopDrag(e) {
		e.stopPropagation()
	}

	// Close the color picker when clicking anywhere else.
	$effect(() => {
		if (!showColors) return
		function close() { showColors = false }
		window.addEventListener('pointerdown', close)
		return () => window.removeEventListener('pointerdown', close)
	})
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="absolute w-52 min-h-36 rounded-lg shadow-md shadow-black/20 select-none border border-black/15
				 transition-shadow hover:shadow-lg hover:shadow-black/30 group flex flex-col text-black touch-none"
	style:left="{note.x}px"
	style:top="{note.y}px"
	style:background={note.color}
	style:cursor={editing ? 'auto' : dragging ? 'grabbing' : 'grab'}
	style:z-index={dragging ? 999 : zIndex}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	ondblclick={(e) => { e.stopPropagation(); startEditing() }}
>
	<!-- Content area -->
	<div class="flex-1 p-3 pb-0">
		{#if editing}
			<!-- svelte-ignore a11y_autofocus -->
			<textarea
				class="w-full min-h-20 bg-transparent resize-none border-none outline-none text-sm
							 break-words whitespace-pre-wrap [field-sizing:content]"
				value={note.content}
				autofocus
				onblur={stopEditing}
				onkeydown={(e) => { if (e.key === 'Escape') e.target.blur() }}
			></textarea>
		{:else}
			<p class="text-sm whitespace-pre-wrap break-words min-h-8 overflow-hidden"
			>{note.content || 'Double-click to edit'}</p>
		{/if}
	</div>

	<!-- Footer: who created this note -->
	<div class="px-3 pb-1.5 pt-1 text-xs opacity-40 text-right shrink-0">{note.creator_name}</div>

	<!-- Hover controls: color picker + delete button -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- On touch devices (no hover), controls are always visible via the
		 @media(hover:none) query handled by Tailwind's active: variant.
		 On desktop, they appear on hover. -->
	<div class="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity flex items-center gap-1" onpointerdown={stopDrag}>
		<button
			class="w-6 h-6 flex items-center justify-center rounded-full text-black/40 hover:text-black/70 hover:bg-black/10 transition-colors"
			aria-label="Pick color"
			onclick={() => showColors = !showColors}
		><Palette size={14} /></button>
		<button
			class="w-6 h-6 flex items-center justify-center rounded-full text-black/40 hover:text-black/70 hover:bg-black/10 transition-colors"
			onclick={() => onDelete()}
			aria-label="Delete note"
		><X size={14} /></button>
	</div>

	<!-- Color picker dropdown -->
	{#if showColors}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="absolute -top-9 right-0 flex gap-1 bg-white/90 backdrop-blur-sm rounded-lg p-1.5 shadow-lg" onpointerdown={stopDrag}>
			{#each NOTE_COLORS as c}
				<button
					class="w-6 h-6 rounded-full border-2 hover:scale-125 transition-transform {note.color === c ? 'border-black/30' : 'border-black/10'}"
					style:background={c}
					aria-label="Set color to {c}"
					onclick={() => { onEdit({ color: c }); showColors = false }}
				></button>
			{/each}
		</div>
	{/if}
</div>
