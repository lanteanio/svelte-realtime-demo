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

	// The canvas background is a board setting, not a theme token, so the
	// empty-state hint must contrast with IT rather than inherit the theme's
	// base-content (near-white on dark, invisible on the default light canvas).
	// The hint is 18px at normal weight, so WCAG AA wants 4.5:1, not the 3:1
	// large-text bar. Measured against the five light board backgrounds, black
	// needs alpha >= 0.545 to clear it; 0.45 lands at ~3.3:1 on all of them.
	const hintColor = $derived.by(() => {
		const m = /^#?([0-9a-f]{6})$/i.exec(background ?? '')
		if (!m) return 'rgba(0, 0, 0, 0.55)'
		const v = parseInt(m[1], 16)
		const luminance = 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)
		return luminance > 128 ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.55)'
	})

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
			<p class="text-lg select-none" style:color={hintColor}>Double-click anywhere to add a note</p>
		</div>
	{/if}

	{@render children?.()}
</div>
