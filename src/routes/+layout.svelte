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
	import { configureApp } from '$lib/configure-app'
	import { browser } from '$app/environment'
	import { Wifi, WifiOff, Sun, Moon, User, Globe, Github, AlertTriangle } from 'lucide-svelte'

	// The app-wide options (resume grace, protocol version) and their
	// rationale live in $lib/configure-app.js.
	configureApp()

	let { children, data } = $props()
	const identity = $derived(data.identity)

	// --- Default note color ---
	// Named so each swatch can carry its own accessible label; color alone
	// cannot distinguish them for a screen reader.
	const NOTE_COLORS = [
		{ value: '#fef08a', name: 'yellow' },
		{ value: '#bbf7d0', name: 'green' },
		{ value: '#bfdbfe', name: 'blue' },
		{ value: '#fbcfe8', name: 'pink' },
		{ value: '#fed7aa', name: 'orange' },
		{ value: '#e9d5ff', name: 'purple' }
	]

	let noteColor = $state(
		(typeof localStorage !== 'undefined' && localStorage.getItem('noteColor')) || NOTE_COLORS[0].value
	)

	function setNoteColor(color) {
		noteColor = color
		localStorage.setItem('noteColor', color)
	}

	// --- Theme ---
	// The inline script in src/app.html has already applied the stored
	// choice to <html data-theme> before paint; we read it back rather
	// than re-deriving it, so the toggle starts in the state on screen.
	let isDark = $state(browser && document.documentElement.dataset.theme === 'dark')

	function setTheme(dark) {
		isDark = dark
		const theme = dark ? 'dark' : 'light'
		document.documentElement.dataset.theme = theme
		try {
			localStorage.setItem('theme', theme)
		} catch (error) {
			// Private mode: the choice still applies for this session.
		}
	}

	// The connection reason lives in a tooltip, which does not exist on
	// touch. Tapping the status pins it open so phone users can read why
	// a connection is down.
	let statusPinned = $state(false)

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
		// DRAIN (new in 0.6): the server is doing a graceful rolling update
		// and dispersed this connection's reconnect over a jittered window.
		$failure?.class === 'DRAIN' ? 'server updating, reconnecting shortly' :
		$status === 'failed' && $failure?.reason ? `${$status}: ${$failure.reason}` :
		$status === 'suspended' ? 'paused (tab in background)' :
		$status === 'disconnected' ? 'reconnecting' :
		$status
	)
</script>

<div class="min-h-screen bg-base-100">
	<div class="navbar bg-base-100 border-b border-base-300 px-2 sm:px-4 min-h-0 h-12">
		<!-- Between 640 and 1023 the end cluster outgrows its navbar half
		     and paints over the wordmark; the count and color picker wait
		     for lg, and the wordmark truncates instead of being covered.
		     daisyUI gives both halves a fixed width:50%, which is what let
		     the end cluster spill. The start half absorbs the slack and the
		     end half sizes to its content, so `ms-auto` is load-bearing:
		     w-auto alone would leave the cluster stranded mid-navbar
		     (width:auto beats daisyUI's layered 50%, and .navbar sets no
		     justify-content of its own). -->
		<div class="navbar-start gap-2 min-w-0">
			<a href="/" class="flex items-center gap-1.5 sm:gap-2 font-bold text-base sm:text-lg min-w-0">
				<img src="/svelte_orange_logo_only.png" alt="Svelte" width="32" height="32" />
				<span class="hidden sm:inline truncate">Svelte Realtime Demo</span>
				<span class="sm:hidden">Demo</span>
			</a>
		</div>

		<div class="navbar-end flex items-center gap-1.5 sm:gap-3 shrink-0 w-auto grow-0 ms-auto">
			<!-- Global online count (wide desktop only) -->
			{#if globalUsers.length > 0}
				<div class="hidden lg:flex items-center gap-1 text-xs opacity-50">
					<Globe size={13} />
					<span>{globalUsers.length} online</span>
				</div>
			{/if}

			<!-- Connection status -->
			<button
				type="button"
				class="tooltip tooltip-bottom btn btn-ghost btn-sm btn-square hover:bg-base-300"
				class:tooltip-open={statusPinned}
				data-tip={statusTooltip}
				aria-label="Connection status: {statusTooltip}"
				onclick={() => (statusPinned = !statusPinned)}
				onblur={() => (statusPinned = false)}
			>
				<StatusIcon size={16} class="{statusColor} {statusOpacity}" />
			</button>

			<!-- Identity -->
			{#if identity}
				<div class="flex items-center gap-1 text-sm">
					<User size={14} style="color: {identity.color}" />
					<span class="font-medium truncate max-w-20 sm:max-w-none">{identity.name}</span>
				</div>

				<!-- Note color picker (wide desktop only) -->
				<div class="hidden lg:flex items-center gap-1">
					{#each NOTE_COLORS as color}
						<button
							class="w-6 h-6 shrink-0 rounded-full border-2 transition-transform hover:scale-110"
							class:border-primary={noteColor === color.value}
							class:border-base-300={noteColor !== color.value}
							style:background={color.value}
							aria-label="Set default note color: {color.name}"
							aria-pressed={noteColor === color.value}
							onclick={() => setNoteColor(color.value)}
						></button>
					{/each}
				</div>
			{/if}

			<!-- GitHub -->
			<a href="https://github.com/lanteanio/svelte-realtime-demo" target="_blank" rel="noopener" class="btn btn-ghost btn-sm btn-square hover:bg-base-300" aria-label="GitHub repository">
				<Github size={16} />
			</a>

			<!-- Theme toggle. The theme-controller class keeps daisyUI's own
			     instant swap; the change handler is what makes the choice
			     outlive the tab (see the bootstrap in src/app.html). -->
			<label class="swap btn btn-ghost btn-sm btn-square hover:bg-base-300">
				<input
					type="checkbox"
					class="theme-controller"
					value="dark"
					checked={isDark}
					aria-label="Toggle dark mode"
					onchange={(event) => setTheme(event.currentTarget.checked)}
				/>
				<Sun size={16} class="swap-off" />
				<Moon size={16} class="swap-on" />
			</label>
		</div>
	</div>

	{#if $health === 'outdated'}
		<!-- Sticky for the session: this tab's bundle predates the server's
		     protocol version. The app decides what to do - we prompt, never
		     auto-reload. -->
		<div class="alert alert-info rounded-none border-x-0 border-t-0 py-2" data-testid="outdated-banner">
			<AlertTriangle size={16} />
			<span class="text-sm">A new version of this app is available.</span>
			<button class="btn btn-xs btn-primary" onclick={() => location.reload()} data-testid="outdated-reload">
				Reload
			</button>
		</div>
	{:else if $health === 'degraded'}
		<div class="alert alert-warning rounded-none border-x-0 border-t-0 py-2">
			<AlertTriangle size={16} />
			<span class="text-sm">Real-time updates paused, reconnecting...</span>
		</div>
	{/if}

	{@render children()}
</div>
