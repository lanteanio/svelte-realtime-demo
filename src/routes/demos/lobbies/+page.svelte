<!--
	/demos/lobbies - rooms with enumeration, ownership, and share codes.

	Left: the live lobby browser (`lobby.rooms()`) - a table appears the
	moment its first subscriber arrives, the member count moves live, and
	each card carries the table's shortCodes() share code. Create a table
	by number, or join by pasting a code (decoded server-side; the secret
	never ships to the client).

	Right: the joined table - an ephemeral message feed, the presence
	row, and the owner role. The first joiner holds ownership with
	deterministic succession; "Close table" is `ownerOnly`, so the server
	rejects any non-owner with FORBIDDEN regardless of what the UI shows.
-->
<script>
	import { lobby, resolveCode } from '$live/demos/lobbies'

	let { data } = $props()
	const me = $derived(data.identity)

	// --- Lobby browser: live view of the export's active rooms ---
	const browserView = lobby.rooms()
	$effect(() => () => browserView.destroy())

	const tables = $derived(
		[...browserView.rooms]
			.map(([key, r]) => ({ key, count: r.count, meta: r.meta }))
			.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
	)

	// --- Create / join ---
	let newId = $state('')
	let codeInput = $state('')
	let joinedId = $state(null)
	let errorMsg = $state('')

	function randomId() {
		newId = String(Math.floor(Math.random() * 1_000_000))
	}

	function joinTable(id) {
		const clean = String(id ?? '').trim()
		if (!/^\d{1,9}$/.test(clean)) {
			errorMsg = 'Table ids are numeric (1-9 digits).'
			return
		}
		errorMsg = ''
		joinedId = clean
	}

	async function handleJoinByCode(e) {
		e?.preventDefault?.()
		const code = codeInput.trim()
		if (!code) return
		try {
			const id = await resolveCode(code)
			if (id === null) {
				errorMsg = 'That code does not decode.'
				return
			}
			errorMsg = ''
			joinedId = id
			codeInput = ''
		} catch (err) {
			errorMsg = err?.message ?? 'Code lookup failed'
		}
	}

	function leaveTable() {
		joinedId = null
		messages = []
		presence = []
		owner = null
	}

	// --- Joined table: data + presence + owner sub-streams ---
	let messages = $state([])
	let presence = $state([])
	let owner = $state(null)
	let streamError = $state(null)

	$effect(() => {
		if (!joinedId) return
		const dataStream = lobby.data(joinedId)
		const presStream = lobby.presence(joinedId)
		const ownerStream = lobby.owner(joinedId)
		const offData = dataStream.subscribe((v) => { messages = v ?? [] })
		const offError = dataStream.error.subscribe((v) => { streamError = v })
		const offPres = presStream.subscribe((v) => { presence = v ?? [] })
		const offOwner = ownerStream.subscribe((v) => { owner = v ?? null })
		return () => {
			offData()
			offError()
			offPres()
			offOwner()
		}
	})

	// Owner keys are the same identity presence uses - the authenticated
	// user id - so the layout's identity cookie id compares directly.
	const isOwner = $derived(owner?.key != null && owner.key === me?.id)

	// --- Actions ---
	let draft = $state('')
	let sending = $state(false)

	async function handleSay(e) {
		e?.preventDefault?.()
		if (sending || !draft.trim() || !joinedId) return
		sending = true
		try {
			await lobby.say(joinedId, draft)
			draft = ''
			errorMsg = ''
		} catch (err) {
			errorMsg = err?.message ?? 'Send failed'
		} finally {
			sending = false
		}
	}

	async function handleClose() {
		if (!joinedId) return
		try {
			await lobby.closeTable(joinedId)
			errorMsg = ''
		} catch (err) {
			// Non-owners are rejected server-side (FORBIDDEN) even if the
			// button were enabled - ownerOnly is the enforcement, not the UI.
			errorMsg = err?.code === 'FORBIDDEN' ? 'Only the table owner can close it.' : (err?.message ?? 'Close failed')
		}
	}
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Lobbies: browse, own, share</h1>
		<p class="text-sm opacity-70 mt-1">
			<code>live.room()</code> with <code>meta</code> +
			<code>enumerable</code> gives every export a live lobby browser
			(<code>lobby.rooms()</code>); <code>owner: true</code> tracks a host
			role with deterministic succession; <code>shortCodes()</code> mints
			the unguessable share code on each card. No registry table, no
			bookkeeping RPCs.
		</p>
	</header>

	{#if errorMsg}
		<p class="text-error text-xs" data-testid="lob-error">{errorMsg}</p>
	{/if}

	<div class="grid gap-4 md:grid-cols-2">
		<div class="space-y-4">
			<div class="card bg-base-200">
				<div class="card-body py-3 space-y-3">
					<h2 class="card-title text-sm">Open a table</h2>
					<form class="space-y-1" onsubmit={(e) => { e.preventDefault(); joinTable(newId) }}>
						<label for="lob-new-id" class="block text-xs font-medium">Table number</label>
						<div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(8rem,1fr)_auto]">
							<!-- Compact on fine pointers, 44px where taps land. -->
							<input
								id="lob-new-id"
								class="input input-bordered input-sm w-full min-w-0 font-mono pointer-coarse:min-h-11"
								bind:value={newId}
								placeholder="Number"
								inputmode="numeric"
								data-testid="lob-new-id"
							/>
							<div class="flex gap-2">
								<button type="button" class="btn btn-sm btn-ghost flex-1 pointer-coarse:min-h-11" onclick={randomId} data-testid="lob-random">random</button>
								<button type="submit" class="btn btn-sm btn-primary flex-1 pointer-coarse:min-h-11" data-testid="lob-create">Join</button>
							</div>
						</div>
					</form>
					<form class="space-y-1" onsubmit={handleJoinByCode}>
						<label for="lob-code-input" class="block text-xs font-medium">Share code</label>
						<div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(6rem,1fr)_auto]">
							<input
								id="lob-code-input"
								class="input input-bordered input-sm w-full min-w-0 font-mono pointer-coarse:min-h-11"
								bind:value={codeInput}
								placeholder="Code"
								maxlength="8"
								data-testid="lob-code-input"
							/>
							<button type="submit" class="btn btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11" data-testid="lob-code-join">Join by code</button>
						</div>
					</form>
				</div>
			</div>

			<div class="card bg-base-100 border border-base-300">
				<div class="card-body py-3 space-y-2">
					<h2 class="card-title text-sm">Active tables</h2>
					<ul class="space-y-2" data-testid="lob-rooms">
						{#each tables as t (t.key)}
							<li
								class="flex items-center gap-2 text-sm"
								data-testid={`lob-room-${t.key}`}
							>
								<span class="font-semibold">{t.meta?.name ?? `Table ${t.key}`}</span>
								{#if t.meta?.code}
									<span class="badge badge-sm badge-outline font-mono" data-testid="lob-room-code">{t.meta.code}</span>
								{/if}
								<span class="opacity-60 text-xs ml-auto" data-testid="lob-room-count">{t.count}/{t.meta?.cap ?? '-'}</span>
								<button
									class="btn btn-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11"
									onclick={() => joinTable(t.key)}
									disabled={joinedId === t.key}
									data-testid={`lob-room-join-${t.key}`}
								>
									{joinedId === t.key ? 'joined' : 'join'}
								</button>
							</li>
						{:else}
							<li class="opacity-40 text-xs py-2">
								No active tables. A table exists while someone is in it -
								open one above.
							</li>
						{/each}
					</ul>
				</div>
			</div>
		</div>

		<div class="card bg-base-100 border border-base-300 min-h-[16rem]">
			<div class="card-body py-3 space-y-2">
				{#if joinedId}
					<div class="flex items-center gap-2">
						<h2 class="card-title text-sm" data-testid="lob-table-title">Table {joinedId}</h2>
						{#if isOwner}
							<span class="badge badge-sm badge-primary" data-testid="lob-owner-badge">you own this table</span>
						{:else if owner?.key}
							<span class="badge badge-sm badge-ghost" data-testid="lob-owner-badge">owned by {owner.key.slice(0, 8)}</span>
						{/if}
						<button class="btn btn-xs btn-ghost ml-auto pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={leaveTable} data-testid="lob-leave">leave</button>
					</div>

					{#if streamError}
						<div class="alert alert-warning text-xs py-2">
							{streamError.code ?? 'ERROR'}: {streamError.message ?? ''}
						</div>
					{/if}

					<ul class="flex flex-wrap gap-1 text-xs" data-testid="lob-presence">
						{#each presence as user (user.key)}
							<li class="badge badge-sm gap-1" style="background-color: {user.data?.color ?? '#888'}; color: white;">
								{user.data?.name ?? 'anon'}
							</li>
						{/each}
					</ul>

					<ul class="space-y-1 text-sm flex-1" data-testid="lob-feed">
						{#each messages as msg (msg.id)}
							<li class="flex gap-2 items-baseline" data-testid="lob-msg">
								<span class="font-semibold" style="color: {msg.color}">{msg.by}</span>
								<span>{msg.text}</span>
							</li>
						{:else}
							<li class="opacity-40 text-xs py-2">
								No messages yet. The feed is ephemeral by design - a
								late joiner starts empty.
							</li>
						{/each}
					</ul>

					<form onsubmit={handleSay} class="flex gap-2">
						<input
							class="input input-bordered input-sm flex-1 pointer-coarse:min-h-11"
							bind:value={draft}
							maxlength="140"
							placeholder="Say something..."
							disabled={sending}
							data-testid="lob-composer-input"
						/>
						<button type="submit" class="btn btn-sm btn-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11" disabled={sending || !draft.trim()} data-testid="lob-send">Send</button>
					</form>

					<button
						class="btn btn-sm btn-error btn-outline pointer-coarse:min-h-11"
						onclick={handleClose}
						disabled={!isOwner}
						data-testid="lob-close"
					>
						Close table (owner only)
					</button>
				{:else}
					<p class="opacity-40 text-sm my-auto text-center">
						Join a table to see its feed, presence, and owner role.
					</p>
				{/if}
			</div>
		</div>
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>lobby = live.room()</code> on
			<code>demos:lobbies:&#123;id&#125;</code> with
			<code>meta</code> (name, code, cap - resolved once when the table
			opens), <code>enumerable: true</code>, <code>owner: true</code>,
			<code>ownerOnly: ['closeTable']</code>, and presence. The browser is
			<code>lobby.rooms()</code> - a snapshot, then live deltas as tables
			open, fill, and close.
		</p>
		<p>
			Codes come from <code>shortCodes(&#123; secret &#125;)</code>: a keyed
			Feistel bijection, so adjacent table numbers map to unrelated codes
			and <code>decode</code> recovers the id server-side (the
			<code>resolveCode</code> RPC) with no lookup table. A code is a share
			handle, not authorization - this room is deliberately guard-free.
			Ownership succession is deterministic: first joiner claims, the
			longest-joined member inherits on departure.
			See <a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/lobbies.js">lobbies.js</a>.
		</p>
	</aside>
</div>
