<!--
	BoardCard -- a single board in the home page list.

	Shows the board title, a live presence badge ("X here") if
	anyone is currently on that board, and a countdown timer showing
	how long until the board expires from inactivity (1 hour TTL).

	Protected boards (like stress-me-out) don't show a timer.
-->
<script>
	import { presence } from 'svelte-adapter-uws/plugins/presence/client'
	import CountdownTimer from './CountdownTimer.svelte'

	let { board, onpresence } = $props()
	const presenceStore = $derived(presence(`board:${board.board_id}`))
	const users = $derived($presenceStore ?? [])

	// Report presence count to parent for sorting
	$effect(() => {
		onpresence?.(users.length)
	})

	const isProtected = $derived(board.slug === 'stress-me-out')
</script>

<a href="/board/{board.slug}" class="card bg-base-200 hover:bg-base-300 transition-colors">
	<div class="card-body p-4 flex-row items-center justify-between">
		<span class="font-medium">{board.title}</span>
		<div class="flex items-center gap-2">
			{#if !isProtected && board.last_activity}
				<CountdownTimer lastActivity={board.last_activity} />
			{/if}
			{#if users.length > 0}
				<span class="badge badge-sm badge-primary">{users.length} here</span>
			{/if}
		</div>
	</div>
</a>
