<!--
	Home page -- board list with create form.

	Boards are sorted by activity: boards with the most users online
	appear first. Boards with equal presence are sorted by most
	recently active. This way the most interesting boards bubble up.

	Creating a board: type a name, hit Create. The RPC runs over
	WebSocket, generates a random slug, inserts into the database,
	and publishes a 'created' event. Every other user's board list
	updates instantly. Then we navigate to the new board.
-->
<script>
	import { boards, createBoard } from '$live/boards'
	import { goto } from '$app/navigation'
	import BoardCard from '$lib/components/BoardCard.svelte'

	let newTitle = $state('')

	// Track presence count per board. Each BoardCard reports its
	// count back here via the onpresence callback. We use this
	// to sort boards by activity (most users first).
	let presenceCounts = $state({})

	const sortedBoards = $derived.by(() => {
		const list = $boards
		if (!list) return undefined
		return [...list].sort((a, b) => {
			const countA = presenceCounts[a.board_id] || 0
			const countB = presenceCounts[b.board_id] || 0
			if (countA !== countB) return countB - countA
			const timeA = new Date(a.last_activity).getTime() || 0
			const timeB = new Date(b.last_activity).getTime() || 0
			return timeB - timeA
		})
	})

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
	<p class="text-sm opacity-50 mb-6">Pick a board or create a new one. No login needed. Boards expire after 1 hour of inactivity.</p>

	<form onsubmit={handleCreate} class="flex gap-2 mb-6">
		<input
			class="input flex-1"
			bind:value={newTitle}
			placeholder="New board name..."
		/>
		<button type="submit" class="btn btn-primary">Create</button>
	</form>

	{#if sortedBoards === undefined}
		<div class="flex justify-center py-8">
			<span class="loading loading-spinner"></span>
		</div>
	{:else}
		<div class="grid gap-3">
			{#each sortedBoards as board (board.board_id)}
				<BoardCard {board} onpresence={(count) => presenceCounts[board.board_id] = count} />
			{/each}
			{#if sortedBoards.length === 0}
				<p class="text-center opacity-40 py-8">No boards yet. Create the first one.</p>
			{/if}
		</div>
	{/if}
</div>
