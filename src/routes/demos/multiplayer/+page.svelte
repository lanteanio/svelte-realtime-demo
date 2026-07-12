<!--
	/demos/multiplayer - every collaborative surface of one room.

	One live.multiplayer export drives the whole page through the
	aggregated room view (lounge.room()):

	- room.cursors renders every visitor's pointer on the shared canvas
	  (self included, so you see your own dot). Moves are volatile sends
	  gated through requestAnimationFrame - at most one publish per
	  frame, lossy under disconnect by contract.
	- room.others is the presence roster (deduped, colored, self
	  excluded once identify() names the local user).
	- The headline input takes the 'headline' advisory lock on focus and
	  releases it on blur. Advisory means awareness, not mutual
	  exclusion: the input disables for OTHER visitors as a courtesy,
	  while the setHeadline action stays the server-side authority.
	- room.setTyping drives the typing indicator while someone edits.
	- The reaction bar emits ephemeral emotes onto the canvas at random
	  coordinates; the ring is bounded, entries fade out via CSS and
	  fall off as new taps arrive.

	The headline itself is the room's data stream: a single crud record
	the setHeadline action validates, stores in Redis, and republishes.
-->
<script>
	import { lounge } from '$live/demos/multiplayer'

	let { data } = $props()
	const me = $derived(data.identity)

	// Name the local user once; me / self-exclusion / isOwner light up.
	lounge.identify(data.identity.id)

	const room = lounge.room()
	const feed = lounge.data()
	const feedError = feed.error

	$effect(() => () => room.destroy())

	const headline = $derived(($feed ?? []).find((r) => r.id === 'headline') ?? null)

	let draft = $state('')
	let editing = $state(false)
	let saving = $state(false)
	let actionError = $state('')

	// Mirror the live headline into the draft while nobody local is
	// editing, so a remote rewrite shows up without clobbering keystrokes.
	$effect(() => {
		if (!editing && headline) draft = headline.text
	})

	const lockHolder = $derived(room.locks['headline'] ?? null)
	const lockedByOther = $derived(lockHolder != null && room.me != null && lockHolder !== room.me)

	/** Resolve a roster key to a display name (self included). */
	function nameFor(key) {
		if (room.me != null && key === room.me) return `${me.name} (you)`
		const peer = room.others.find((p) => p.key === key)
		return peer?.data?.name ?? 'anon'
	}

	const lockHolderName = $derived(lockHolder != null ? nameFor(lockHolder) : null)
	const typingNames = $derived(room.typing.map(nameFor))

	function errText(err) {
		return err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
	}

	// One cursor publish per animation frame, no matter how fast the
	// pointer moves. Coordinates are normalized to the canvas so dots
	// land on the same relative spot in differently sized windows.
	let rafPending = false
	function onPointerMove(e) {
		if (rafPending) return
		rafPending = true
		const rect = e.currentTarget.getBoundingClientRect()
		const x = Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 1000
		const y = Math.round(((e.clientY - rect.top) / rect.height) * 1000) / 1000
		requestAnimationFrame(() => {
			rafPending = false
			room.move({ x, y })
		})
	}

	async function focusHeadline() {
		editing = true
		try {
			await room.acquireLock('headline')
			actionError = ''
		} catch (err) {
			actionError = errText(err)
		}
	}

	async function blurHeadline() {
		editing = false
		try {
			await room.setTyping(false)
			await room.releaseLock('headline')
		} catch (err) {
			actionError = errText(err)
		}
	}

	function inputHeadline() {
		// Fire-and-forget flag; errors here would only ever be transport
		// noise, but keep the same guard as every other send path.
		try { room.setTyping(true) } catch { /* transient flag, ignore */ }
	}

	async function submitHeadline(e) {
		e.preventDefault()
		if (saving || !draft.trim()) return
		saving = true
		try {
			await lounge.setHeadline(draft)
			actionError = ''
		} catch (err) {
			actionError = errText(err)
		} finally {
			saving = false
		}
	}

	const REACTIONS = [
		{ token: 'heart', emoji: '❤️' },
		{ token: 'fire', emoji: '🔥' },
		{ token: 'clap', emoji: '👏' },
		{ token: 'star', emoji: '⭐' }
	]
	const emojiFor = (token) => REACTIONS.find((r) => r.token === token)?.emoji ?? token

	function sendReaction(token) {
		try {
			// Random spot inside the canvas so simultaneous taps scatter.
			room.react(token, {
				x: Math.round((0.1 + Math.random() * 0.8) * 1000) / 1000,
				y: Math.round((0.2 + Math.random() * 0.6) * 1000) / 1000
			})
		} catch (err) {
			actionError = errText(err)
		}
	}
</script>

<div class="max-w-4xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Multiplayer lounge: one room, every surface</h1>
		<p class="text-sm opacity-70 mt-1">
			A single <code>live.multiplayer</code> export with
			<code>cursors</code>, <code>typing</code>, <code>locks</code>, and
			<code>reactions</code> enabled. Move your pointer over the canvas
			to broadcast your cursor, tap an emote to drop it at a random
			spot, and focus the headline to take the advisory
			<code>'headline'</code> lock - other visitors see who holds it and
			their input disables until you blur. Open a second tab to watch
			every surface fan out.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Here as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
			</p>
		{/if}
	</header>

	<!-- Presence roster -->
	<section class="card bg-base-100 border border-base-300">
		<div class="card-body py-3">
			<h2 class="card-title text-sm">In the lounge</h2>
			<ul class="flex flex-wrap gap-2 text-xs" data-testid="mp-roster">
				{#if me}
					<li class="badge gap-1 text-white" style:background={me.color}>{me.name} (you)</li>
				{/if}
				{#each room.others as person (person.key)}
					<li class="badge gap-1 text-white" style:background={person.color} data-testid="mp-roster-other">
						{person.data?.name ?? 'anon'}
					</li>
				{/each}
			</ul>
			<p class="text-xs opacity-50" data-testid="mp-typing">
				{typingNames.length > 0 ? `${typingNames.join(', ')} ${typingNames.length === 1 ? 'is' : 'are'} typing...` : 'Nobody is typing.'}
			</p>
		</div>
	</section>

	<!-- Shared canvas: cursors + floating reactions -->
	<section class="card bg-base-100 border border-base-300">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Shared canvas</h2>
			<div
				class="relative h-72 rounded bg-base-200 overflow-hidden touch-none select-none"
				onpointermove={onPointerMove}
				data-testid="mp-canvas"
			>
				{#each room.cursors as c (c.key)}
					<div
						class="absolute pointer-events-none transition-all duration-75"
						style="left: {(c.x ?? 0) * 100}%; top: {(c.y ?? 0) * 100}%;"
						data-testid="mp-cursor"
					>
						<div class="w-3 h-3 rounded-full border-2 border-base-100 -translate-x-1/2 -translate-y-1/2" style:background={c.color}></div>
						<div class="text-[10px] font-semibold px-1 rounded text-white whitespace-nowrap" style:background={c.color}>
							{nameFor(c.key)}
						</div>
					</div>
				{/each}
				{#each room.reactions as r (r)}
					<div
						class="absolute text-2xl pointer-events-none mp-reaction"
						style="left: {(r.x ?? 0.5) * 100}%; top: {(r.y ?? 0.5) * 100}%;"
						data-testid="mp-reaction"
					>
						{emojiFor(r.token)}
					</div>
				{/each}
				<p class="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs opacity-30 pointer-events-none">
					Move your pointer here. Cursors are volatile sends, one per frame.
				</p>
			</div>
			<div class="flex gap-2">
				{#each REACTIONS as r (r.token)}
					<button
						class="btn btn-ghost btn-sm text-lg"
						onclick={() => sendReaction(r.token)}
						aria-label="React with {r.token}"
						data-testid="mp-react-{r.token}"
					>
						{r.emoji}
					</button>
				{/each}
			</div>
		</div>
	</section>

	<!-- Headline: data stream + advisory lock + typing -->
	<section class="card bg-base-200">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Shared headline (advisory lock on focus)</h2>
			<p class="text-lg font-semibold" data-testid="mp-headline-display">
				{headline?.text ?? 'loading...'}
			</p>
			{#if headline?.by}
				<p class="text-xs opacity-50">last set by {headline.by}</p>
			{/if}
			<form onsubmit={submitHeadline} class="flex gap-2 items-center">
				<input
					class="input input-bordered input-sm flex-1"
					bind:value={draft}
					maxlength="80"
					disabled={lockedByOther || saving}
					placeholder={lockedByOther ? `Locked by ${lockHolderName}` : 'Rewrite the headline (max 80 chars)...'}
					onfocus={focusHeadline}
					onblur={blurHeadline}
					oninput={inputHeadline}
					data-testid="mp-headline-input"
				/>
				<button
					type="submit"
					class="btn btn-primary btn-sm"
					disabled={lockedByOther || saving || !draft.trim()}
					data-testid="mp-headline-submit"
					onmousedown={(e) => e.preventDefault()}
				>
					{saving ? 'Saving...' : 'Set headline'}
				</button>
			</form>
			<p class="text-xs opacity-60" data-testid="mp-lock-state">
				{#if lockHolder == null}
					Lock free.
				{:else if lockedByOther}
					Locked by {lockHolderName}.
				{:else}
					You hold the lock.
				{/if}
			</p>
			{#if actionError}
				<p class="text-xs text-error" data-testid="mp-error">{actionError}</p>
			{/if}
			{#if $feedError}
				<p class="text-xs text-error" data-testid="mp-feed-error">
					{$feedError.code ?? 'ERROR'}: {$feedError.message ?? ''}
				</p>
			{/if}
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>lounge = live.multiplayer(&#123; presence, cursors: true,
			typing: true, locks: ['headline'], reactions: true, actions:
			&#123; setHeadline &#125; &#125;)</code> on one fixed topic. The client
			consumes it through <code>lounge.room()</code>: <code>room.others</code>,
			<code>room.cursors</code> (driven by <code>room.move</code>),
			<code>room.typing</code> / <code>room.setTyping</code>,
			<code>room.locks</code> / <code>room.acquireLock</code> /
			<code>room.releaseLock</code>, and <code>room.reactions</code> /
			<code>room.react</code>. Typing, locks, and selections are presence
			fields stamped on the roster; reactions ride their own ephemeral
			stream.
		</p>
		<p>
			The headline is the room's data stream: <code>init</code> loads one
			crud record from Redis and the <code>setHeadline</code> action
			validates, stores, and publishes <code>'updated'</code>. See
			<a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/multiplayer.js">multiplayer.js</a>.
		</p>
	</aside>
</div>

<style>
	@keyframes mp-float {
		from {
			opacity: 1;
			transform: translate(-50%, -50%);
		}
		to {
			opacity: 0;
			transform: translate(-50%, calc(-50% - 3rem));
		}
	}
	.mp-reaction {
		animation: mp-float 2.5s ease-out forwards;
	}
</style>
