<!--
	Canvas -- the scrollable board area where notes live.

	The outer div is a fixed-height scrollable viewport. The inner div
	is a large virtual surface (minimum 3000x2000, grows to fit notes).
	On desktop, scrollbars appear when notes exceed the viewport.
	On mobile, touch-drag on empty space pans the view (native scroll).
	Touch-drag on a note moves the note (handled by StickyNote's
	touch-action:none + pointer capture).

	Also handles:
	1. Pointer tracking for cursor sharing (onPointerMove)
	2. Double-click/tap to create notes (ondblclick, passed from parent)
-->
<script>
	import { batch } from 'svelte-realtime/client'
	import { moveCursor } from '$live/boards/cursors'

	let { children, background, boardId, ondblclick, noteCount = 0 } = $props()
	let canvasEl = $state()

	// Coalesce rapid pointer events into one RPC per frame.
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
		// Use scroll-adjusted coordinates so cursor positions are
		// relative to the virtual surface, not the viewport.
		pendingCursor = {
			x: e.clientX - canvasEl.getBoundingClientRect().left + canvasEl.scrollLeft,
			y: e.clientY - canvasEl.getBoundingClientRect().top + canvasEl.scrollTop
		}
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
	style:height="calc(100dvh - 7rem)"
	onpointermove={onPointerMove}
	{ondblclick}
>
	<!--
		Inner surface: minimum 3000x2000 so there's always room to scroll.
		Notes are absolutely positioned within this surface.
	-->
	<div class="relative min-w-[3000px] min-h-[2000px]">
		{#if noteCount === 0}
			<div class="fixed inset-0 flex items-center justify-center pointer-events-none" style:top="7rem">
				<p class="text-lg opacity-30 select-none">Double-click anywhere to add a note</p>
			</div>
		{/if}

		{@render children?.()}
	</div>
</div>
