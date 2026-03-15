<!--
	BoardHeader -- board title (editable) + background color picker + TTL timer.

	Double-click the title to edit it inline. Press Enter or click away
	to save. The background color buttons change the canvas background
	for all users on the board in real time.

	The countdown timer shows how long until this board expires from
	inactivity. Every note/settings action resets the timer server-side.

	The children slot renders the PresenceBar on the right side.
-->
<script>
	import CountdownTimer from './CountdownTimer.svelte'
	import { Clock } from 'lucide-svelte'

	let { settings, onUpdate, children } = $props()
	let editingTitle = $state(false)

	// 5 light backgrounds + 1 dark option
	const BACKGROUNDS = ['#f5f5f4', '#fefce8', '#ecfdf5', '#eff6ff', '#fdf4ff', '#1e1e2e']

	const isProtected = $derived(settings?.slug === 'stress-me-out')
</script>

<div class="navbar bg-base-100/80 backdrop-blur-sm border-b border-base-300 px-4 min-h-0 py-1">
	<div class="navbar-start">
		{#if editingTitle}
			<input
				class="input input-sm w-48"
				value={settings?.title ?? ''}
				onblur={(e) => { editingTitle = false; onUpdate({ title: e.target.value }) }}
				onkeydown={(e) => { if (e.key === 'Enter') e.target.blur() }}
			/>
		{:else}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<h1
				class="text-sm font-bold cursor-pointer hover:underline"
				ondblclick={() => editingTitle = true}
			>{settings?.title ?? 'Untitled Board'}</h1>
		{/if}

		<div class="flex gap-1 ml-4">
			{#each BACKGROUNDS as bg}
				<button
					class="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 {settings?.background === bg ? 'border-primary' : 'border-base-content/30'}"
					style:background={bg}
					aria-label="Set background to {bg}"
					onclick={() => onUpdate({ background: bg })}
				></button>
			{/each}
		</div>

		{#if !isProtected && settings?.last_activity}
			<div class="flex items-center gap-1 ml-4 opacity-70">
				<Clock size={12} />
				<CountdownTimer lastActivity={settings.last_activity} compact />
			</div>
		{/if}
	</div>

	<div class="navbar-end">
		{@render children?.()}
	</div>
</div>
