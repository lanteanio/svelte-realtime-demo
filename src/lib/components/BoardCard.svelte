<!--
	BoardCard - a single board in the home page list.

	Shows the board title, a live presence badge ("X here") if
	anyone is currently on that board, and a countdown timer showing
	how long until the board expires from inactivity (1 hour TTL).

	Protected boards (like stress-me-out) don't show a timer.
-->
<script>
	import { presence } from 'svelte-adapter-uws/plugins/presence/client'
	import CountdownTimer from './CountdownTimer.svelte'

	let { board, onpresence } = $props()
	// maxAge matches the server-side per-field TTL (90s). Without this,
	// an entry that expires in Redis via HPEXPIRE (no diff fires for
	// per-field expiry) would linger on the home page forever -- you'd
	// see "1 here" for a board that nobody is actually on. The next
	// heartbeat for a still-present user re-adds them via the new
	// {key:data} heartbeat shape, so legitimate users do not flicker.
	const presenceStore = $derived(presence(`board:${board.board_id}`, { maxAge: 90000 }))
	const users = $derived($presenceStore ?? [])

	// Report presence count to parent for sorting
	$effect(() => {
		onpresence?.(users.length)
	})

	const isProtected = $derived(board.slug === 'stress-me-out')
</script>

<!-- min-w-0 on the grid item too: a grid track's min-width:auto would
     otherwise size the card to the nowrap title's intrinsic width and
     the truncate below could never engage. -->
<a href="/board/{board.slug}" class="card bg-base-200 hover:bg-base-300 transition-colors min-w-0">
	<div class="card-body p-4 flex-row items-center justify-between">
		<!-- Titles are server-capped at 100 chars but may be one unbroken
		     token; without min-w-0 + truncate a single hostile title sets
		     the row's min-content width and widens the whole page. -->
		<span class="font-medium min-w-0 truncate" title={board.title}>{board.title}</span>
		<div class="flex items-center gap-2 shrink-0">
			{#if !isProtected && board.last_activity}
				<CountdownTimer lastActivity={board.last_activity} />
			{/if}
			{#if users.length > 0}
				<!-- nowrap is load-bearing: a daisyUI badge has a fixed height,
				     so when a long title squeezed this row the label wrapped and
				     "here" rendered outside the pill. -->
				<span class="badge badge-sm badge-primary shrink-0 whitespace-nowrap">{users.length} here</span>
			{/if}
		</div>
	</div>
</a>
