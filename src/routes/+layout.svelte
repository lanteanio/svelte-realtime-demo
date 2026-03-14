<script>
	import '../app.css'
	import { status } from 'svelte-adapter-uws/client'

	let { children, data } = $props()
	const identity = $derived(data.identity)

	const statusColor = $derived(
		$status === 'open' ? '#22c55e' :
		$status === 'connecting' ? '#f59e0b' : '#ef4444'
	)
</script>

<div class="min-h-screen bg-base-100">
	<div class="navbar bg-base-100 border-b border-base-300 px-4">
		<div class="navbar-start">
			<a href="/" class="text-lg font-bold">Sticky Notes</a>
		</div>
		<div class="navbar-end flex items-center gap-3">
			<!-- Connection status dot -->
			<div class="tooltip tooltip-bottom" data-tip={$status}>
				<span class="w-2.5 h-2.5 rounded-full inline-block" style:background={statusColor}></span>
			</div>

			<!-- Your identity -->
			{#if identity}
				<div class="flex items-center gap-1.5 text-sm">
					<span class="w-3 h-3 rounded-full" style:background={identity.color}></span>
					<span class="font-medium">{identity.name}</span>
				</div>
			{/if}

			<!-- Theme toggle -->
			<label class="swap btn btn-ghost btn-sm">
				<input type="checkbox" class="theme-controller" value="dark" />
				<div class="swap-on">Dark</div>
				<div class="swap-off">Light</div>
			</label>
		</div>
	</div>

	{@render children()}
</div>
