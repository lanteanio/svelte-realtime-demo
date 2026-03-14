<script>
	import { on } from 'svelte-adapter-uws/client'

	let { boardId } = $props()
	const cursorTopic = $derived(on(`__cursor:board:${boardId}`))
	const cursors = $derived($cursorTopic?.data ?? [])
</script>

<svg class="absolute inset-0 w-full h-full pointer-events-none" style:z-index="100">
	{#each cursors as c (c.id)}
		<g transform="translate({c.x}, {c.y})" style:transition="transform 50ms linear">
			<path d="M0,0 L0,16 L4,12 L8,18 L10,17 L6,11 L12,11 Z" fill={c.color} />
			<rect x="14" y="6" rx="3" width={c.name.length * 7 + 8} height="18" fill={c.color} opacity="0.85" />
			<text x="18" y="18" fill="white" font-size="11" font-weight="500">{c.name}</text>
		</g>
	{/each}
</svg>
