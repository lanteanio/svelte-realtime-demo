<!--
	BoardHeader -- board title, background picker, TTL timer, presence.

	On mobile:
	- Title truncates to prevent overflow
	- Background colors use smaller circles
	- Presence bar shows max 3 avatars
	- Everything fits in one or two rows via flex-wrap
-->
<script>
	import CountdownTimer from './CountdownTimer.svelte'
	import { Clock } from 'lucide-svelte'

	let { settings, onUpdate, children } = $props()
	let editingTitle = $state(false)

	const BACKGROUNDS = ['#f5f5f4', '#fefce8', '#ecfdf5', '#eff6ff', '#fdf4ff', '#1e1e2e']

	const isProtected = $derived(settings?.slug === 'stress-me-out')
</script>

<div class="flex flex-wrap items-center gap-x-2 sm:gap-x-4 gap-y-1 bg-base-100/80 backdrop-blur-sm border-b border-base-300 px-2 sm:px-4 py-1 min-h-8">
	<!-- Title -->
	{#if editingTitle}
		<input
			class="input input-sm w-36 sm:w-48"
			value={settings?.title ?? ''}
			onblur={(e) => { editingTitle = false; onUpdate({ title: e.target.value }) }}
			onkeydown={(e) => { if (e.key === 'Enter') e.target.blur() }}
		/>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<h1
			class="text-sm font-bold cursor-pointer hover:underline truncate max-w-24 sm:max-w-none"
			ondblclick={() => editingTitle = true}
		>{settings?.title ?? 'Untitled Board'}</h1>
	{/if}

	<!-- Background colors (hidden on mobile to save space) -->
	<div class="hidden sm:flex gap-1 shrink-0">
		{#each BACKGROUNDS as bg}
			<button
				class="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 {settings?.background === bg ? 'border-primary' : 'border-base-content/30'}"
				style:background={bg}
				aria-label="Set background to {bg}"
				onclick={() => onUpdate({ background: bg })}
			></button>
		{/each}
	</div>

	<!-- TTL timer -->
	{#if !isProtected && settings?.last_activity}
		<div class="flex items-center gap-1 opacity-70 shrink-0">
			<Clock size={12} />
			<CountdownTimer lastActivity={settings.last_activity} />
		</div>
	{/if}

	<!-- Presence bar (pushed right) -->
	<div class="ml-auto shrink-0">
		{@render children?.()}
	</div>
</div>
