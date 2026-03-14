<script>
	import { boards, createBoard } from '$live/boards'
	import { goto } from '$app/navigation'
	import BoardCard from '$lib/components/BoardCard.svelte'

	let newTitle = $state('')

	async function handleCreate(e) {
		e.preventDefault()
		if (!newTitle.trim()) return
		const board = await createBoard(newTitle)
		newTitle = ''
		goto(`/board/${board.slug}`)
	}
</script>

<div class="max-w-xl mx-auto p-8">
	<h1 class="text-2xl font-bold mb-2">Boards</h1>
	<p class="text-sm opacity-50 mb-6">Pick a board or create a new one. No login needed.</p>

	<form onsubmit={handleCreate} class="flex gap-2 mb-6">
		<input
			class="input flex-1"
			bind:value={newTitle}
			placeholder="New board name..."
		/>
		<button type="submit" class="btn btn-primary">Create</button>
	</form>

	{#if $boards === undefined}
		<div class="flex justify-center py-8">
			<span class="loading loading-spinner"></span>
		</div>
	{:else}
		<div class="grid gap-3">
			{#each $boards as board (board.board_id)}
				<BoardCard {board} />
			{/each}
			{#if $boards.length === 0}
				<p class="text-center opacity-40 py-8">No boards yet. Create the first one.</p>
			{/if}
		</div>
	{/if}
</div>
