<!--
	Canvas - the board area where notes live.

	On desktop: notes are positioned absolutely, scrollbars appear
	if notes go beyond the viewport.
	On mobile: two-finger pan to scroll, one-finger on note to drag.

	Also handles:
	1. Pointer tracking for cursor sharing (onPointerMove)
	2. Double-click/tap to create notes (ondblclick, passed from parent)
-->
<script>
	import { batch } from 'svelte-realtime/client'
	import { moveCursor } from '$live/boards/cursors'

	let { children, background, boardId, ondblclick, noteCount = 0 } = $props()
	let canvasEl = $state()

	let pendingCursor = null
	let rafScheduled = false

	function flushCursor() {
		rafScheduled = false
		if (!pendingCursor || !boardId) return
		const pos = pendingCursor
		pendingCursor = null
		batch(() => [moveCursor(boardId, pos)])
	}

	function onPointerMove(e) {
		if (!canvasEl) return
		const rect = canvasEl.getBoundingClientRect()
		// Bitwise `| 0` truncates to int32 (faster than Math.floor and produces
		// the same result for non-negative values, which page coordinates always
		// are). Saves ~15-25 bytes per cursor wire frame vs the default float
		// JSON representation (e.g. `742.0843811035156` -> `742`). Visually:
		// labels render sharper because drawImage with integer offsets does
		// 1:1 pixel mapping instead of bilinear interpolation; the arrow itself
		// is roughly equivalent (its diagonals anti-alias regardless of
		// translate fractional part).
		//
		// Caveat for future-you: this quantizes DOCUMENT coordinates. If a
		// zoom feature ever lands, 1-document-pixel quantization becomes
		// N-screen-pixel quantization at zoom N, which becomes visible. Move
		// the truncation downstream of any zoom transform if that day comes.
		pendingCursor = {
			x: (e.clientX - rect.left + canvasEl.scrollLeft) | 0,
			y: (e.clientY - rect.top + canvasEl.scrollTop) | 0
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
	{#if noteCount === 0}
		<div class="absolute inset-0 flex items-center justify-center pointer-events-none">
			<p class="text-lg opacity-30 select-none">Double-click anywhere to add a note</p>
		</div>
	{/if}

	{@render children?.()}
</div>
