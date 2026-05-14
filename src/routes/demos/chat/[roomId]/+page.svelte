<!--
	/demos/chat/[roomId] - room surface.

	Three things on one page:

	1. live.room() bundles the message list and presence list as two
	   sub-streams of one declaration: chat.data(roomId) and
	   chat.presence(roomId). One topic pair, two reactive accessors.

	2. live.idempotent({ ttl }) wraps sendMessage. The "Send" button
	   uses a fresh idempotencyKey per click; the "Retry x5" button
	   reuses one key across five rapid calls and posts ONE message.

	3. The wire-level subscribe denial for the `private` room
	   surfaces on the data stream's `.error` store with
	   `code: 'FORBIDDEN'`. We render a banner; messages never appear.
-->
<script>
	import { page } from '$app/stores'
	import { chat, sendMessage } from '$live/demos/chat'

	const roomId = $derived($page.params.roomId)

	let messages = $state([])
	let presence = $state([])
	let error = $state(null)

	let draft = $state('')
	let sending = $state(false)
	let lastSentKey = $state(null)

	const denied = $derived(error?.code === 'FORBIDDEN')

	// Explicit .subscribe() in $effect: lets the same code handle a
	// reactive roomId (re-runs and cleans up on change) without relying
	// on Svelte's $store auto-subscribe to compose with $derived.
	$effect(() => {
		const data = chat.data(roomId)
		const pres = chat.presence(roomId)
		const offMessages = data.subscribe((v) => { messages = v ?? [] })
		const offPresence = pres.subscribe((v) => { presence = v ?? [] })
		const offError = data.error.subscribe((v) => { error = v })
		return () => {
			offMessages()
			offPresence()
			offError()
		}
	})

	async function handleSend(e) {
		e?.preventDefault?.()
		if (sending || !draft.trim() || denied) return
		sending = true
		const idempotencyKey = crypto.randomUUID()
		lastSentKey = idempotencyKey
		try {
			await sendMessage.with({ idempotencyKey })(roomId, draft)
			draft = ''
		} finally {
			sending = false
		}
	}

	async function handleRetryFive() {
		if (sending || !draft.trim() || denied) return
		sending = true
		const idempotencyKey = crypto.randomUUID()
		lastSentKey = idempotencyKey
		try {
			const text = draft
			const calls = Array.from({ length: 5 }, () =>
				sendMessage.with({ idempotencyKey })(roomId, text)
			)
			await Promise.all(calls)
			draft = ''
		} finally {
			sending = false
		}
	}
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header class="flex items-center justify-between">
		<div>
			<a href="/demos/chat" class="link link-hover text-sm opacity-60">&larr; Rooms</a>
			<h1 class="text-2xl font-bold mt-2">
				Chat: <span class="font-mono">{roomId}</span>
			</h1>
		</div>
		<div class="text-xs opacity-60" data-testid="presence-count">
			{presence.length} online
		</div>
	</header>

	{#if denied}
		<div class="alert alert-error" data-testid="forbidden-banner">
			<div>
				<div class="font-semibold">Forbidden</div>
				<div class="text-xs opacity-80">
					This room is members-only. The server denied the
					subscribe with <code>FORBIDDEN</code>.
				</div>
			</div>
		</div>
	{:else if error}
		<div class="alert alert-warning">
			<div>
				<div class="font-semibold">{error.code ?? 'ERROR'}</div>
				<div class="text-xs opacity-80">{error.message ?? ''}</div>
			</div>
		</div>
	{/if}

	{#if !denied}
		<div class="card bg-base-200 shadow">
			<div class="card-body py-3">
				<h2 class="card-title text-sm">Online</h2>
				<ul class="flex flex-wrap gap-2 text-xs">
					{#each presence as user (user.key)}
						<li class="badge gap-1" style="background-color: {user.data?.color ?? '#888'}; color: white;">
							{user.data?.name ?? 'anon'}
						</li>
					{:else}
						<li class="opacity-40">Nobody else here yet.</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}

	<div class="card bg-base-100 border border-base-300 min-h-[20rem]">
		<div class="card-body py-3">
			<h2 class="card-title text-sm">Messages</h2>
			<ul class="space-y-1 text-sm" data-testid="messages">
				{#each messages as msg (msg.id)}
					<li class="flex gap-2 items-baseline">
						<span class="font-semibold" style="color: {msg.color}">{msg.name}</span>
						<span>{msg.text}</span>
						<span class="opacity-30 text-xs ml-auto">
							{new Date(msg.ts).toLocaleTimeString()}
						</span>
					</li>
				{:else}
					<li class="opacity-40 text-center py-4">
						{denied ? 'No access.' : 'No messages yet. Be the first.'}
					</li>
				{/each}
			</ul>
		</div>
	</div>

	<form onsubmit={handleSend} class="flex gap-2">
		<input
			class="input input-bordered flex-1"
			bind:value={draft}
			placeholder={denied ? 'Cannot send to a denied room' : 'Type a message...'}
			disabled={denied || sending}
			data-testid="message-input"
		/>
		<button
			type="submit"
			class="btn btn-primary"
			disabled={denied || sending || !draft.trim()}
			data-testid="send-button"
		>
			Send
		</button>
		<button
			type="button"
			class="btn btn-warning"
			onclick={handleRetryFive}
			disabled={denied || sending || !draft.trim()}
			data-testid="retry-five-button"
		>
			Retry x5 (same key)
		</button>
	</form>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>chat = live.room()</code> with topic
			<code>demos:chat:&#123;roomId&#125;</code>;
			<code>sendMessage = live.idempotent(&#123; ttl: 30 &#125;, ...)</code>.
		</p>
		<p>
			Send fires one RPC per click with a fresh idempotencyKey.
			Retry x5 fires five rapid RPCs with the same key; only the
			first runs the handler, the other four return the cached
			result. One intent, one message.
		</p>
		<p>
			Open this page in two tabs to see realtime fan-out and
			the presence list update as users join and leave.
		</p>
		{#if lastSentKey}
			<p class="font-mono text-[10px] opacity-50">
				Last idempotencyKey: {lastSentKey}
			</p>
		{/if}
	</aside>
</div>
