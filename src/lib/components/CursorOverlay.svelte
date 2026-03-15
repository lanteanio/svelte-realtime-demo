<script>
	import { cursor } from 'svelte-adapter-uws/plugins/cursor/client'

	let { boardId, userId } = $props()
	const cursorStore = $derived(cursor(`board:${boardId}`))
	const cursors = $derived([...$cursorStore].filter(([, { user }]) => user.id !== userId))
</script>

<svg class="absolute inset-0 w-full h-full pointer-events-none" style:z-index="2147483647">
	{#each cursors as [key, { user, data }] (key)}
		<g transform="translate({data.x}, {data.y})" style:will-change="transform">
			<path d="M0,0 L0,16 L4,12 L8,18 L10,17 L6,11 L12,11 Z" fill={user.color} />
			<text x="16" y="18" fill="white" paint-order="stroke" stroke="{user.color}e0"
				stroke-width="3" font-size="11" font-weight="500">{user.name}</text>
		</g>
	{/each}
</svg>
