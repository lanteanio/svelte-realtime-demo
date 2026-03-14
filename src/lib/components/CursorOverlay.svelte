<script>
	import { cursor } from 'svelte-adapter-uws/plugins/cursor/client'

	let { boardId, userId } = $props()
	const cursorStore = $derived(cursor(`board:${boardId}`))
	const cursors = $derived([...$cursorStore].filter(([, { user }]) => user.id !== userId))
</script>

<svg class="absolute inset-0 w-full h-full pointer-events-none" style:z-index="2147483647">
	{#each cursors as [key, { user, data }] (key)}
		<g transform="translate({data.x}, {data.y})" style:transition="transform 50ms linear">
			<path d="M0,0 L0,16 L4,12 L8,18 L10,17 L6,11 L12,11 Z" fill={user.color} />
			<foreignObject x="14" y="6" width="200" height="22" overflow="visible">
				<span
					class="inline-block px-1.5 py-0.5 rounded text-white text-[11px] font-medium leading-tight whitespace-nowrap"
					style:background="{user.color}e0"
				>{user.name}</span>
			</foreignObject>
		</g>
	{/each}
</svg>
