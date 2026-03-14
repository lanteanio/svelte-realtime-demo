<script>
	let { note, zIndex = 1, onMove, onMoveEnd, onEdit, onDelete, onFocus } = $props()
	let dragging = $state(false)
	let editing = $state(false)
	let showColors = $state(false)
	let offset = $state({ x: 0, y: 0 })

	const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff']

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
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="absolute w-48 min-h-32 rounded-lg shadow-md p-3 select-none
				 transition-shadow hover:shadow-lg group"
	style:left="{note.x}px"
	style:top="{note.y}px"
	style:background={note.color}
	style:cursor={dragging ? 'grabbing' : 'grab'}
	style:z-index={dragging ? 999 : zIndex}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
>
	{#if editing}
		<textarea
			class="w-full h-full bg-transparent resize-none border-none outline-none text-sm"
			value={note.content}
			onblur={(e) => { editing = false; onEdit({ content: e.target.value }) }}
			onkeydown={(e) => { if (e.key === 'Escape') editing = false }}
		></textarea>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<p
			class="text-sm whitespace-pre-wrap cursor-text min-h-8"
			ondblclick={(e) => { e.stopPropagation(); editing = true }}
		>{note.content || 'Double-click to edit'}</p>
	{/if}

	<!-- Top-right controls: color picker toggle + delete -->
	<div class="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5">
		<button
			class="w-5 h-5 rounded-full border border-black/20"
			style:background={note.color}
			aria-label="Pick color"
			onclick={(e) => { e.stopPropagation(); showColors = !showColors }}
		></button>
		<button class="btn btn-ghost btn-xs btn-circle" onclick={onDelete}>x</button>
	</div>

	<!-- Color picker row -->
	{#if showColors}
		<div class="absolute -top-8 right-0 flex gap-1 bg-white/90 rounded-lg p-1 shadow-md">
			{#each NOTE_COLORS as c}
				<button
					class="w-5 h-5 rounded-full border border-black/10 hover:scale-125 transition-transform"
					style:background={c}
					aria-label="Set color to {c}"
					onclick={(e) => { e.stopPropagation(); onEdit({ color: c }); showColors = false }}
				></button>
			{/each}
		</div>
	{/if}

	<div class="absolute bottom-1 right-2 text-xs opacity-40">{note.creator_name}</div>
</div>
