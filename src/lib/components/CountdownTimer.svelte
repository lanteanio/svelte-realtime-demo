<!--
	CountdownTimer -- shows time remaining before a board expires.

	Uses DaisyUI's countdown component. Updates every second.
	Changes color as the deadline approaches:
	- > 10 min: neutral (text-base-content/50)
	- 5-10 min: warning
	- < 5 min: error (pulses)

	When the countdown reaches zero the board has already been deleted
	by the server cron. The home page receives a 'deleted' event and
	removes the card. The board page should redirect home.
-->
<script>
	const TTL_MS = 60 * 60 * 1000

	let { lastActivity, compact = false } = $props()

	let remaining = $state(0)

	function update() {
		const expiresAt = new Date(lastActivity).getTime() + TTL_MS
		remaining = Math.max(0, expiresAt - Date.now())
	}

	$effect(() => {
		// Recalculate whenever lastActivity changes
		void lastActivity
		update()
		const timer = setInterval(update, 1000)
		return () => clearInterval(timer)
	})

	const minutes = $derived(Math.floor(remaining / 60000))
	const seconds = $derived(Math.floor((remaining % 60000) / 1000))

	const urgency = $derived(
		remaining === 0 ? 'text-error' :
		minutes < 5 ? 'text-error animate-pulse' :
		minutes < 10 ? 'text-warning' :
		'text-base-content/50'
	)
</script>

{#if compact}
	<span class="text-xs tabular-nums {urgency}">
		{minutes}:{seconds.toString().padStart(2, '0')}
	</span>
{:else}
	<span class="flex items-center gap-1 font-mono text-xs {urgency}">
		<span class="countdown">
			<span style="--value:{minutes};"></span>
		</span>m
		<span class="countdown">
			<span style="--value:{seconds};"></span>
		</span>s
	</span>
{/if}
