<!--
	CountdownTimer -- shows time remaining before a board expires.

	Uses DaisyUI's countdown component for the animated digit transition.
	Updates every second. Changes color as the deadline approaches:
	- > 10 min: neutral (text-base-content/50)
	- 5-10 min: warning
	- < 5 min: error (pulses)
-->
<script>
	const TTL_MS = 60 * 60 * 1000

	let { lastActivity } = $props()

	let remaining = $state(0)

	function update() {
		const expiresAt = new Date(lastActivity).getTime() + TTL_MS
		// Round down to the nearest full second so the display always
		// decrements by exactly 1 second per tick, even if setInterval
		// fires slightly early or late.
		const raw = Math.max(0, expiresAt - Date.now())
		remaining = Math.floor(raw / 1000) * 1000
	}

	$effect(() => {
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

<span class="countdown font-mono text-xs {urgency}">
	<span style="--value:{minutes};" aria-live="polite" aria-label="{minutes}">{minutes}</span>
	:
	<span style="--value:{seconds}; --digits: 2;" aria-live="polite" aria-label="{seconds}">{seconds}</span>
</span>
