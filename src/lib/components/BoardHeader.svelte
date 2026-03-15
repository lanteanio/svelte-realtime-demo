<!--
	BoardHeader -- board title (editable) + background color picker + TTL timer.

	Double-click the title to edit it inline. Press Enter or click away
	to save. The background color buttons change the canvas background
	for all users on the board in real time.

	On mobile:
	- Title truncates with ellipsis to prevent overflow
	- Color picker and timer stay compact
	- PresenceBar (children slot) wraps below if needed

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

<div class="flex flex-wrap items-center gap-x-4 gap-y-1 bg-base-100/80 backdrop-blur-sm border-b border-base-300 px-4 py-1">
	<!-- Left group: title + colors + timer -->
	<div class="flex items-center gap-2 min-w-0 shrink">
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
				class="text-sm font-bold cursor-pointer hover:underline truncate max-w-32 sm:max-w-none"
				ondblclick={() => editingTitle = true}
			>{settings?.title ?? 'Untitled Board'}</h1>
		{/if}

		<div class="flex gap-1 shrink-0">
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
			<div class="flex items-center gap-1 opacity-70 shrink-0">
				<Clock size={12} />
				<CountdownTimer lastActivity={settings.last_activity} />
			</div>
		{/if}
	</div>

	<!-- Right group: presence bar (pushed to the right) -->
	<div class="ml-auto shrink-0">
		{@render children?.()}
	</div>
</div>
