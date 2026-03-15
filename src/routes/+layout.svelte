<!--
	Root layout -- wraps every page in the app.

	Renders the top navbar with:
	- App logo/name (links to home)
	- Global online count (all connected users across all boards)
	- WebSocket connection status (green wifi = connected)
	- Your identity (random name + color assigned on first visit)
	- Default note color picker (persisted in localStorage)
	- Dark/light theme toggle (DaisyUI theme-controller)

	The page content ({@render children()}) appears below the navbar.
-->
<script>
	import '../app.css'
	import { status } from 'svelte-adapter-uws/client'
	import { presence } from 'svelte-adapter-uws/plugins/presence/client'
	import { Wifi, WifiOff, Sun, Moon, User, Globe, Github } from 'lucide-svelte'

	let { children, data } = $props()
	const identity = $derived(data.identity)

	// --- Default note color ---
	// When you create a note, it uses whatever color is selected here.
	// Saved to localStorage so it persists across sessions.
	const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff']

	let noteColor = $state(
		(typeof localStorage !== 'undefined' && localStorage.getItem('noteColor')) || NOTE_COLORS[0]
	)

	function setNoteColor(color) {
		noteColor = color
		localStorage.setItem('noteColor', color)
	}

	// --- Global presence ---
	// Everyone who connects to the app joins the "global" presence channel
	// (see hooks.ws.js open()). maxAge: 90s auto-cleans stale entries.
	// The server heartbeat (30s) keeps live users' timestamps fresh.
	const globalPresence = presence('global', { maxAge: 90000 })
	const globalUsers = $derived($globalPresence ?? [])

	// --- Connection status ---
	// $status is a Svelte store from the adapter that tracks the WebSocket
	// state: 'open', 'connecting', or 'closed'.
	const statusColor = $derived(
		$status === 'open' ? 'text-success' :
		$status === 'connecting' ? 'text-warning' : 'text-error'
	)
</script>

<div class="min-h-screen bg-base-100">
	<div class="navbar bg-base-100 border-b border-base-300 px-4">
		<div class="navbar-start">
			<a href="/" class="flex items-center gap-2 text-lg font-bold">
				<img src="/Svelte_Logo.svg" alt="Svelte" width="20" height="24" />
				<span class="hidden sm:inline">Svelte Realtime Demo</span>
				<span class="sm:hidden">Demo</span>
			</a>
		</div>
		<div class="navbar-end flex items-center gap-3">
			<!-- Global online count -->
			{#if globalUsers.length > 0}
				<div class="flex items-center gap-1 text-xs opacity-50">
					<Globe size={13} />
					<span>{globalUsers.length} online</span>
				</div>
			{/if}

			<!-- Connection status indicator -->
			<div class="tooltip tooltip-bottom" data-tip={$status}>
				{#if $status === 'open'}
					<Wifi size={16} class={statusColor} />
				{:else}
					<WifiOff size={16} class={statusColor} />
				{/if}
			</div>

			<!-- Your identity + note color picker -->
			{#if identity}
				<div class="flex items-center gap-1.5 text-sm">
					<User size={14} style="color: {identity.color}" />
					<span class="font-medium">{identity.name}</span>
				</div>
				<div class="flex items-center gap-1">
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

			<!-- GitHub link -->
			<a href="https://github.com/lanteanio/svelte-realtime-demo" target="_blank" rel="noopener" class="btn btn-ghost btn-sm btn-square hover:bg-base-300">
				<Github size={16} />
			</a>

			<!-- Dark/light theme toggle (DaisyUI swap component) -->
			<label class="swap btn btn-ghost btn-sm btn-square hover:bg-base-300">
				<input type="checkbox" class="theme-controller" value="dark" />
				<Sun size={16} class="swap-off" />
				<Moon size={16} class="swap-on" />
			</label>
		</div>
	</div>

	{@render children()}
</div>
