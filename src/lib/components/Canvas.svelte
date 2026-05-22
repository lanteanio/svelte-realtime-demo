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
	// Adapter's `move()` helper sends the direct `{type:'cursor', topic, data}`
	// wire frame -- no RPC id, no pending-promise map entry, no timeout timer,
	// no devtools/dedup overhead. Internal rAF coalescing collapses native
	// pointermove storms (500-1000Hz on high-poll-rate mice) into at most one
	// send per repaint. Server picks it up via the cursor extension's
	// hooks.message dispatch wired in hooks.ws.js (onUnhandled).
	import { move as moveCursor } from 'svelte-adapter-uws/plugins/cursor/client'

	let { children, background, boardId, ondblclick, noteCount = 0 } = $props()
	let canvasEl = $state()

	function onPointerMove(e) {
		if (!canvasEl || !boardId) return
		const rect = canvasEl.getBoundingClientRect()
		moveCursor(`board:${boardId}`, {
			x: e.clientX - rect.left + canvasEl.scrollLeft,
			y: e.clientY - rect.top + canvasEl.scrollTop
		})
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
