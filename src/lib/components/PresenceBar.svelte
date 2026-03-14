<script>
	import { presence } from 'svelte-adapter-uws/plugins/presence/client'
	import { joinBoard, leaveBoard } from '$live/boards/cursors'

	let { boardId } = $props()
	const presenceStore = $derived(presence(`board:${boardId}`))
	const users = $derived($presenceStore ?? [])

	$effect(() => {
		joinBoard(boardId)
		return () => {
			leaveBoard(boardId)
		}
	})
</script>

<div class="flex items-center gap-2">
	<span class="text-xs opacity-50">{users.length} online</span>
	<div class="avatar-group -space-x-3">
		{#each users as user (user.id)}
			<div class="tooltip" data-tip={user.name}>
				<div class="avatar placeholder">
					<div class="w-7 h-7 rounded-full flex items-center justify-center" style:background={user.color}>
						<span class="text-xs text-white font-bold leading-none">{(user.name ?? '').split(' ').map(w => w[0]).join('')}</span>
					</div>
				</div>
			</div>
		{/each}
	</div>
</div>
