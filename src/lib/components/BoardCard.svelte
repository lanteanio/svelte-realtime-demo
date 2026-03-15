<!--
	BoardCard -- a single board in the home page list.

	Shows the board title and a live presence badge ("X here") if
	anyone is currently on that board. The presence data comes from
	subscribing to the board's presence channel -- so the badge
	updates in real time without polling.
-->
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
