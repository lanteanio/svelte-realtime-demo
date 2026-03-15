<!--
	Canvas -- the scrollable board area where notes live.

	Handles two things:
	1. Pointer tracking for cursor sharing (onPointerMove)
	2. Double-click to create notes (ondblclick, passed from parent)

	Cursor updates are throttled with requestAnimationFrame so we send
	at most one cursor position per frame (~60/sec), even though the
	browser fires pointermove events much more frequently.
-->
<script>
	import { batch } from 'svelte-realtime/client'
	import { moveCursor } from '$live/boards/cursors'

	let { children, background, boardId, ondblclick, noteCount = 0 } = $props()
	let canvasEl = $state()

	// Coalesce rapid pointer events into one RPC per frame.
	// Without this, every pixel of mouse movement sends a WebSocket message.
	let pendingCursor = null
	let rafScheduled = false

	function flushCursor() {
		rafScheduled = false
		if (!pendingCursor) return
		const pos = pendingCursor
		pendingCursor = null
		batch(() => [moveCursor(boardId, pos)])
	}

	function onPointerMove(e) {
		if (!canvasEl) return
		const rect = canvasEl.getBoundingClientRect()
		pendingCursor = { x: e.clientX - rect.left, y: e.clientY - rect.top }
		if (!rafScheduled) {
			rafScheduled = true
			requestAnimationFrame(flushCursor)
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={canvasEl}
	class="relative w-full overflow-auto"
	style:background
	style:height="calc(100vh - 7rem)"
	onpointermove={onPointerMove}
	{ondblclick}
>
	{#if noteCount === 0}
		<div class="absolute inset-0 flex items-center justify-center pointer-events-none">
			<p class="text-lg opacity-30 select-none">Double-click anywhere to add a note</p>
		</div>
	{/if}

	{@render children?.()}
</div>
