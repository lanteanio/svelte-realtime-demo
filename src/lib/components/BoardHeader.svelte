<!--
	BoardHeader - board title, background picker, TTL timer, presence.

	On mobile:
	- The full title wraps on its own row
	- Background colors use smaller circles
	- Presence bar shows max 3 avatars
	- Controls wrap below the title when they need more room
-->
<script>
	import CountdownTimer from './CountdownTimer.svelte'
	import { Clock, Pencil, Plus } from 'lucide-svelte'

	let { settings, onUpdate, children, onAddNote } = $props()
	let editingTitle = $state(false)
	let renameButton = $state()
	function focusTitle(node) {
		node.focus()
		node.select()
	}

	const BACKGROUNDS = ['#f5f5f4', '#fefce8', '#ecfdf5', '#eff6ff', '#fdf4ff', '#1e1e2e']

	const isProtected = $derived(settings?.slug === 'stress-me-out')
</script>

<div class="flex shrink-0 flex-wrap items-center gap-x-2 sm:gap-x-4 gap-y-1 bg-base-100/80 backdrop-blur-sm border-b border-base-300 px-2 sm:px-4 py-1 min-h-8">
	<!-- Title -->
	<div class="w-full min-w-0 lg:w-auto lg:flex-1">
		{#if editingTitle}
			<input
				class="input input-sm w-full"
				aria-label="Board name"
				use:focusTitle
				value={settings?.title ?? ''}
				onblur={(e) => { editingTitle = false; onUpdate({ title: e.target.value }) }}
				onkeydown={(event) => {
					if (event.key !== 'Enter') return
					event.preventDefault()
					event.currentTarget.blur()
					renameButton?.focus()
				}}
			/>
		{:else}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<h1
				class="page-title cursor-pointer hover:underline"
				ondblclick={() => editingTitle = true}
			>{settings?.title ?? 'Untitled Board'}</h1>
		{/if}
	</div>
	<button bind:this={renameButton} class="btn btn-ghost btn-xs btn-square" aria-label="Rename board" onclick={() => editingTitle = true}>
		<Pencil size={14} />
	</button>

	<!-- Keyboard- and touch-reachable note creation; dblclick stays the pointer fast path. -->
	{#if onAddNote}
		<button class="btn btn-ghost btn-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={onAddNote} aria-label="Add note" data-testid="board-add-note">
			<Plus size={14} /> Note
		</button>
	{/if}
	<!-- Background colors (hidden on mobile to save space) -->
	<div class="hidden sm:flex gap-1 shrink-0">
		{#each BACKGROUNDS as bg}
			<!-- Compact on fine pointers; full 44px circles on coarse ones, flex-wrap absorbs
			     the extra width. A fixed mid-contrast border keeps the light swatches distinct
			     on the dark theme; the active swatch carries a ring plus a checkmark. -->
			{@const selected = settings?.background === bg}
			<button
				class="w-5 h-5 rounded-full border border-black/20 flex items-center justify-center transition-transform hover:scale-110 pointer-coarse:w-11 pointer-coarse:h-11 {selected ? 'ring-2 ring-primary ring-offset-1 ring-offset-base-100' : ''}"
				style:background={bg}
				aria-label="Set background to {bg}"
				aria-pressed={selected}
				onclick={() => onUpdate({ background: bg })}
			>{#if selected}<span class="text-[10px] leading-none" style:color={bg === '#1e1e2e' ? '#ffffffcc' : '#00000099'}>&#10003;</span>{/if}</button>
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
