<script>
	let { items = [] } = $props()
	const latest = $derived(items.slice(-5).toReversed())
</script>

<div class="fixed bottom-0 left-0 right-0 bg-base-200/80 backdrop-blur-sm
						border-t border-base-300 px-4 py-1.5 flex gap-6 overflow-hidden text-xs">
	{#each latest as item (item.ts)}
		<span class="whitespace-nowrap flex items-center gap-1">
			<span class="w-2 h-2 rounded-full inline-block" style:background={item.color}></span>
			<span class="font-semibold">{item.user}</span>
			{item.action}
		</span>
	{/each}
	{#if latest.length === 0}
		<span class="opacity-40">No activity yet -- double-click the canvas to add a note</span>
	{/if}
</div>
