<script>
	import { presence } from 'svelte-adapter-uws/plugins/presence/client'
	import { joinBoard, leaveBoard } from '$live/boards/cursors'

	const MAX_AVATARS = 8

	let { boardId } = $props()
	const presenceStore = $derived(presence(`board:${boardId}`, { maxAge: 90000 }))
	const users = $derived($presenceStore ?? [])
	const visible = $derived(users.slice(0, MAX_AVATARS))
	const overflow = $derived(Math.max(0, users.length - MAX_AVATARS))

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
		{#each visible as user (user.id)}
			<div class="tooltip" data-tip={user.name}>
				<div class="avatar placeholder">
					<div class="w-7 h-7 rounded-full flex items-center justify-center" style:background={user.color}>
						<span class="text-xs text-white font-bold leading-none">{(user.name ?? '').split(' ').map(w => w[0]).join('')}</span>
					</div>
				</div>
			</div>
		{/each}
		{#if overflow > 0}
			<div class="avatar placeholder">
				<div class="w-7 h-7 rounded-full flex items-center justify-center bg-neutral text-neutral-content">
					<span class="text-[10px] font-bold leading-none">+{overflow}</span>
				</div>
			</div>
		{/if}
	</div>
</div>
