<!--
	Root layout - wraps every page in the app.

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
	import { status, failure } from 'svelte-adapter-uws/client'
	import { presence } from 'svelte-adapter-uws/plugins/presence/client'
	import { health } from 'svelte-realtime/client'
	import { Wifi, WifiOff, Sun, Moon, User, Globe, Github, AlertTriangle } from 'lucide-svelte'

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
	// The five-state status machine plus a failure store
	// with the cause of the latest non-open transition. We map each
	// state to icon + colour + opacity, and render the failure reason
	// in the tooltip when terminal so users know why we are down.
	const StatusIcon = $derived($status === 'failed' || $status === 'disconnected' ? WifiOff : Wifi)
	const statusColor = $derived(
		$status === 'open' || $status === 'suspended' ? 'text-success' :
		$status === 'connecting' || $status === 'disconnected' ? 'text-warning' :
		'text-error'
	)
	const statusOpacity = $derived($status === 'suspended' ? 'opacity-50' : '')
	const statusTooltip = $derived(
		$status === 'failed' && $failure?.reason ? `${$status}: ${$failure.reason}` :
		$status === 'suspended' ? 'paused (tab in background)' :
		$status === 'disconnected' ? 'reconnecting' :
		$status
	)
</script>

<div class="min-h-screen bg-base-100">
	<div class="navbar bg-base-100 border-b border-base-300 px-2 sm:px-4 min-h-0 h-12">
		<div class="navbar-start gap-2">
			<a href="/" class="flex items-center gap-1.5 sm:gap-2 font-bold text-base sm:text-lg">
				<img src="/svelte_orange_logo_only.png" alt="Svelte" width="32" height="32" />
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
			<div class="tooltip tooltip-bottom" data-tip={statusTooltip}>
				<StatusIcon size={16} class="{statusColor} {statusOpacity}" />
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

	{#if $health === 'degraded'}
		<div class="alert alert-warning rounded-none border-x-0 border-t-0 py-2">
			<AlertTriangle size={16} />
			<span class="text-sm">Real-time updates paused, reconnecting...</span>
		</div>
	{/if}

	{@render children()}
</div>
