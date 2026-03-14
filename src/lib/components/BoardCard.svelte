<script>
	import { on } from 'svelte-adapter-uws/client'

	let { board } = $props()
	const boardId = $derived(board.board_id)
	const presenceTopic = $derived(on(`__presence:board:${boardId}`))
	const count = $derived($presenceTopic?.data?.length ?? 0)
</script>

<a href="/board/{board.slug}" class="card bg-base-200 hover:bg-base-300 transition-colors">
	<div class="card-body p-4 flex-row items-center justify-between">
		<span class="font-medium">{board.title}</span>
		{#if count > 0}
			<span class="badge badge-sm badge-primary">{count} here</span>
		{/if}
	</div>
</a>
