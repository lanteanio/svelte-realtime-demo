<!--
	Root layout -- wraps every page in the app.

	Renders the top navbar with:
	- App logo/name (links to home)
	- Global online count (hidden on mobile)
	- WebSocket connection status
	- Your identity name
	- Default note color picker (hidden on mobile)
	- GitHub link
	- Dark/light theme toggle

	On mobile (< 640px) the navbar drops the color picker and global
	count to prevent overflow. The identity name is shortened.
-->
<script>
	import '../app.css'
	import { status } from 'svelte-adapter-uws/client'
	import { presence } from 'svelte-adapter-uws/plugins/presence/client'
	import { Wifi, WifiOff, Sun, Moon, User, Globe, Github } from 'lucide-svelte'

	let { children, data } = $props()
	const identity = $derived(data.identity)

	// --- Default note color ---
	const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff']

	let noteColor = $state(
		(typeof localStorage !== 'undefined' && localStorage.getItem('noteColor')) || NOTE_COLORS[0]
	)

	function setNoteColor(color) {
		noteColor = color
		localStorage.setItem('noteColor', color)
	}

	// --- Global presence ---
	const globalPresence = presence('global', { maxAge: 90000 })
	const globalUsers = $derived($globalPresence ?? [])

	// --- Connection status ---
	const statusColor = $derived(
		$status === 'open' ? 'text-success' :
		$status === 'connecting' ? 'text-warning' : 'text-error'
	)
</script>

<div class="min-h-screen bg-base-100">
	<div class="navbar bg-base-100 border-b border-base-300 px-2 sm:px-4 min-h-0 h-12">
		<div class="navbar-start gap-2">
			<a href="/" class="flex items-center gap-1.5 sm:gap-2 font-bold text-base sm:text-lg">
				<img src="/Svelte_Logo.svg" alt="Svelte" width="20" height="24" />
				<span class="hidden sm:inline">Svelte Realtime Demo</span>
				<span class="sm:hidden">Demo</span>
			</a>
		</div>

		<div class="navbar-end flex items-center gap-1.5 sm:gap-3">
			<!-- Global online count (desktop only) -->
			{#if globalUsers.length > 0}
				<div class="hidden sm:flex items-center gap-1 text-xs opacity-50">
					<Globe size={13} />
					<span>{globalUsers.length} online</span>
				</div>
			{/if}

			<!-- Connection status -->
			<div class="tooltip tooltip-bottom" data-tip={$status}>
				{#if $status === 'open'}
					<Wifi size={16} class={statusColor} />
				{:else}
					<WifiOff size={16} class={statusColor} />
				{/if}
			</div>

			<!-- Identity -->
			{#if identity}
				<div class="flex items-center gap-1 text-sm">
					<User size={14} style="color: {identity.color}" />
					<span class="font-medium truncate max-w-20 sm:max-w-none">{identity.name}</span>
				</div>

				<!-- Note color picker (desktop only) -->
				<div class="hidden sm:flex items-center gap-1">
					{#each NOTE_COLORS as color}
						<button
							class="w-4 h-4 rounded-full border-2 transition-transform hover:scale-125"
							class:border-primary={noteColor === color}
							class:border-base-300={noteColor !== color}
							style:background={color}
							aria-label="Set default note color"
							onclick={() => setNoteColor(color)}
						></button>
					{/each}
				</div>
			{/if}

			<!-- GitHub -->
			<a href="https://github.com/lanteanio/svelte-realtime-demo" target="_blank" rel="noopener" class="btn btn-ghost btn-sm btn-square hover:bg-base-300">
				<Github size={16} />
			</a>

			<!-- Theme toggle -->
			<label class="swap btn btn-ghost btn-sm btn-square hover:bg-base-300">
				<input type="checkbox" class="theme-controller" value="dark" />
				<Sun size={16} class="swap-off" />
				<Moon size={16} class="swap-on" />
			</label>
		</div>
	</div>

	{@render children()}
</div>
