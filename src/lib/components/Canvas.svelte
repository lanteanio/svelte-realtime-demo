<script>
	import { on } from 'svelte-adapter-uws/client'

	let { children, background, boardId, ondblclick, noteCount = 0 } = $props()
	let canvasEl = $state()

	const cursorChannel = $derived(on(`__cursor:board:${boardId}`))

	function onPointerMove(e) {
		if (!canvasEl) return
		const rect = canvasEl.getBoundingClientRect()
		cursorChannel?.send?.({
			x: e.clientX - rect.left,
			y: e.clientY - rect.top
		})
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
	<!-- Empty board hint -->
	{#if noteCount === 0}
		<div class="absolute inset-0 flex items-center justify-center pointer-events-none">
			<p class="text-lg opacity-30 select-none">Double-click anywhere to add a note</p>
		</div>
	{/if}

	{@render children?.()}
</div>
