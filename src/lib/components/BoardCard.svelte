<script>
	import { presence } from 'svelte-adapter-uws/plugins/presence/client'

	let { board } = $props()
	const presenceStore = $derived(presence(`board:${board.board_id}`))
	const users = $derived($presenceStore ?? [])
</script>

<a href="/board/{board.slug}" class="card bg-base-200 hover:bg-base-300 transition-colors">
	<div class="card-body p-4 flex-row items-center justify-between">
		<span class="font-medium">{board.title}</span>
		{#if users.length > 0}
			<span class="badge badge-sm badge-primary">{users.length} here</span>
		{/if}
	</div>
</a>
