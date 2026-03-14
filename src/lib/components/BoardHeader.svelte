<script>
	let { settings, onUpdate, children } = $props()
	let editingTitle = $state(false)

	const BACKGROUNDS = ['#f5f5f4', '#fefce8', '#ecfdf5', '#eff6ff', '#fdf4ff', '#1e1e2e']
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
	</div>

	<div class="navbar-end">
		{@render children?.()}
	</div>
</div>
