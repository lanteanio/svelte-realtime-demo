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
				<svg viewBox="0 0 15 16" width="20" height="20" class="inline-block">
					<path d="M13.7 1.6C12.4.3 10.5-.1 8.9.6 7.2 1.3 6 2.8 5.8 4.6c-.1.9 0 1.8.3 2.6.1.3 0 .6-.2.8L1.6 12.3c-.6.6-.6 1.6 0 2.1l.1.1c.6.6 1.5.6 2.1 0L8 10.3c.2-.2.5-.3.8-.2.8.3 1.7.4 2.6.3 1.8-.2 3.3-1.4 4-3.1.7-1.6.3-3.5-1-4.8l-.7.1z" fill="#ff3e00"/>
					<path d="M5.3 11.5c-.4.4-1 .4-1.4 0-.4-.4-.4-1 0-1.4l3.2-3.2c.1-.1.2-.3.1-.5-.2-.6-.3-1.2-.2-1.8.1-1.2.9-2.3 2-2.8 1.1-.5 2.4-.2 3.3.6.9.9 1.2 2.2.6 3.3-.5 1.1-1.6 1.9-2.8 2-.6.1-1.2 0-1.8-.2-.2-.1-.4 0-.5.1l-3.2 3.2.7-.3z" fill="#fff" opacity=".3"/>
				</svg>
				Svelte Realtime Demo
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
			<a href="https://github.com/lanteanio/svelte-realtime-demo" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">
				<Github size={16} />
			</a>

			<!-- Dark/light theme toggle (DaisyUI swap component) -->
			<label class="swap btn btn-ghost btn-sm">
				<input type="checkbox" class="theme-controller" value="dark" />
				<Sun size={16} class="swap-off" />
				<Moon size={16} class="swap-on" />
			</label>
		</div>
	</div>

	{@render children()}
</div>
