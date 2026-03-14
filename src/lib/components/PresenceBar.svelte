<script>
	import { on } from 'svelte-adapter-uws/client'

	let { boardId } = $props()
	const presenceTopic = $derived(on(`__presence:board:${boardId}`))
	const users = $derived($presenceTopic?.data ?? [])
</script>

<div class="flex items-center gap-2">
	<span class="text-xs opacity-50">{users.length} online</span>
	<div class="avatar-group -space-x-3">
		{#each users as user (user.id)}
			<div class="tooltip" data-tip={user.name}>
				<div class="avatar placeholder">
					<div class="w-7 rounded-full" style:background={user.color}>
						<span class="text-xs text-white font-bold">{user.name.split(' ').map(w => w[0]).join('')}</span>
					</div>
				</div>
			</div>
		{/each}
	</div>
</div>
