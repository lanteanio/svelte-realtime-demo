<!--
	PresenceBar - shows who's currently on this board.

	Displays up to 8 avatar circles with user initials, plus a "+N"
	overflow badge if there are more users. The "X online" count always
	shows the real total.

	The board page owns participation and supplies its acknowledged
	canonical topic. This component only reads that topic's roster.

	maxAge: 90000 (90 seconds) auto-removes stale entries on the
	client side. The server sends heartbeat events every 30 seconds
	to keep live users' timestamps fresh. If a user disconnects and
	the server fails to broadcast a leave event, the client removes
	them after 90 seconds automatically.
-->
<script>
	import { presence } from 'svelte-adapter-uws/plugins/presence/client'
	import { empty } from 'svelte-realtime/client'

	const MAX_AVATARS_DESKTOP = 8
	const MAX_AVATARS_MOBILE = 1

	let { topic } = $props()
	const presenceStore = $derived(topic ? presence(topic, { maxAge: 90000 }) : empty)
	const users = $derived($presenceStore ?? [])

	// Detect mobile by checking window width. Falls back to desktop cap
	// on SSR where window is undefined.
	let isMobile = $state(false)
	$effect(() => {
		const mq = window.matchMedia('(max-width: 639px)')
		isMobile = mq.matches
		function onChange(e) { isMobile = e.matches }
		mq.addEventListener('change', onChange)
		return () => mq.removeEventListener('change', onChange)
	})

	const maxAvatars = $derived(isMobile ? MAX_AVATARS_MOBILE : MAX_AVATARS_DESKTOP)
	const visible = $derived(users.slice(0, maxAvatars))
	const overflow = $derived(Math.max(0, users.length - maxAvatars))

</script>

<div class="flex items-center gap-2">
	<span class="text-xs opacity-50">{users.length} on this board</span>
	<div class="avatar-group -space-x-3">
		{#each visible as user (user.id)}
			<div class="tooltip" data-tip={user.name}>
				<div class="avatar placeholder">
					<div class="w-7 h-7 rounded-full flex items-center justify-center" style:background={user.color}>
						<!-- Initials: "Cosmic Penguin" -> "CP" -->
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
