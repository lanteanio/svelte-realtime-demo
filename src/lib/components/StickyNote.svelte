<!--
	StickyNote -- a draggable, editable sticky note card.

	Interaction model:
	- Click: brings to front (z-index)
	- Drag: moves the note (pointer capture for smooth dragging)
	- Double-click: enters edit mode (shows textarea)
	- Escape or blur: exits edit mode and saves
	- Hover: shows delete (X) and color picker (palette) buttons

	Drag performance:
	- During drag, position is controlled by direct DOM writes (no Svelte)
	- Server RPCs are throttled to 100ms intervals (not every frame)
	- Svelte-controlled position is frozen during drag to prevent
	  server responses from fighting with the direct DOM writes
	- Remote users see smooth movement via CSS transition interpolation
-->
<script>
	import { Palette, X } from 'lucide-svelte'
	let { note, zIndex = 1, onMove, onMoveEnd, onEdit, onDelete, onFocus } = $props()
	let dragging = $state(false)
	let editing = $state(false)
	let showColors = $state(false)

	// Frozen position: during drag, Svelte uses these instead of note.x/y
	// so server responses don't cause re-renders or overwrite the DOM.
	let frozenX = $state(0)
	let frozenY = $state(0)

	const displayX = $derived(dragging ? frozenX : note.x)
	const displayY = $derived(dragging ? frozenY : note.y)

	const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff']

	// --- Drag state (plain variables, not reactive) ---
	let dragEl = null
	let offsetX = 0
	let offsetY = 0
	let startRectLeft = 0
	let startRectTop = 0
	let startScrollX = 0
	let startScrollY = 0
	let lastX = 0
	let lastY = 0
	let rpcTimer = null

	function onPointerDown(e) {
		if (editing) return
		onFocus()

		dragEl = e.currentTarget
		const canvas = dragEl.parentElement
		const rect = canvas?.getBoundingClientRect()
		startRectLeft = rect?.left ?? 0
		startRectTop = rect?.top ?? 0
		startScrollX = canvas?.scrollLeft ?? 0
		startScrollY = canvas?.scrollTop ?? 0

		const cx = e.clientX - startRectLeft + startScrollX
		const cy = e.clientY - startRectTop + startScrollY
		offsetX = cx - note.x
		offsetY = cy - note.y

		// Freeze position so Svelte stops controlling transform
		frozenX = note.x
		frozenY = note.y
		dragging = true

		// Send RPCs at 100ms intervals -- fast enough for other users
		// to see smooth movement, slow enough to not cause re-render jank.
		rpcTimer = setInterval(() => {
			onMove(lastX, lastY)
		}, 100)

		dragEl.setPointerCapture(e.pointerId)
	}

	function onPointerMove(e) {
		if (!dragging) return
		lastX = e.clientX - startRectLeft + startScrollX - offsetX
		lastY = e.clientY - startRectTop + startScrollY - offsetY
		// Direct DOM write only. No Svelte, no reactivity, no re-render.
		dragEl.style.transform = `translate(${lastX}px, ${lastY}px)`
	}

	function onPointerUp() {
		if (!dragging) return
		clearInterval(rpcTimer)
		rpcTimer = null
		// Send final position
		onMove(lastX, lastY)
		// Update frozen position to match where we dropped it,
		// then hand control back to Svelte.
		frozenX = lastX
		frozenY = lastY
		dragging = false
		dragEl = null
		onMoveEnd()
	}

	// --- Edit handling ---

	function startEditing() {
		editing = true
	}

	function stopEditing(e) {
		editing = false
		onEdit({ content: e.target.value })
	}

	function stopDrag(e) {
		e.stopPropagation()
	}

	$effect(() => {
		if (!showColors) return
		function close() { showColors = false }
		window.addEventListener('pointerdown', close)
		return () => window.removeEventListener('pointerdown', close)
	})
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="absolute w-52 min-h-36 rounded-lg select-none border border-black/15
				 group flex flex-col text-black touch-none
				 {dragging ? 'shadow-lg shadow-black/30' : 'shadow-md shadow-black/20'}"
	style:transform="translate({displayX}px, {displayY}px)"
	style:left="0"
	style:top="0"
	style:background={note.color}
	style:cursor={editing ? 'auto' : dragging ? 'grabbing' : 'grab'}
	style:z-index={dragging ? 999 : zIndex}
	style:will-change={dragging ? 'transform' : 'auto'}
	style:transition={dragging ? 'none' : 'transform 80ms linear'}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	ondblclick={(e) => { e.stopPropagation(); startEditing() }}
>
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

	<div class="px-3 pb-1.5 pt-1 text-xs opacity-40 text-right shrink-0">{note.creator_name}</div>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
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
