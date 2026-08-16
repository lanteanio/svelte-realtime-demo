<!--
	/demos/chat - room picker.

	Three rooms. Two are open; one is members-only. Picking the
	private room demonstrates the wire-level subscribe denial: the
	chat surface renders a FORBIDDEN banner and shows zero messages.
-->
<script>
	const rooms = [
		{ id: 'general', label: 'General', desc: 'Open to everyone.' },
		{ id: 'random', label: 'Random', desc: 'Open to everyone.' },
		{ id: 'private', label: 'Private', desc: 'Members-only. Click to see the FORBIDDEN denial.' }
	]
</script>

<div class="max-w-2xl mx-auto p-8 space-y-6">
	<header>

		<h1 class="text-2xl font-bold mt-2">Chat rooms</h1>
		<p class="text-sm opacity-70 mt-1">
			Pick a room. <code>live.room()</code> bundles the message
			stream and the user-presence list into one declaration.
			<code>live.idempotent</code> wraps the send RPC so a retry
			lands one message. The members-only room demos the wire
			denial banner.
		</p>
	</header>

	<ul class="grid gap-3">
		{#each rooms as room (room.id)}
			<li>
				<a
					href="/demos/chat/{room.id}"
					class="card card-compact bg-base-200 hover:bg-base-300 transition-colors"
					data-testid="room-link-{room.id}"
				>
					<!-- A hover background shift was the only cue that these were
					     doors, and hover never fires on touch - so on a phone the
					     lobby read as three descriptions and the page's single
					     required action had no signifier at all. The arrow is the
					     door handle, present in a static glance on every input. -->
					<div class="card-body flex-row items-center gap-3">
						<div class="min-w-0">
							<div class="font-semibold">{room.label}</div>
							<div class="text-xs opacity-60">{room.desc}</div>
						</div>
						<span class="ml-auto text-lg opacity-50" aria-hidden="true" data-testid="room-enter-{room.id}">&rarr;</span>
					</div>
				</a>
			</li>
		{/each}
	</ul>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>chat = live.room(&#123; topic, init, presence
			&#125;)</code> - one declaration bundles the durable message
			stream and the live user-presence roster per room. The separate
			<code>sendMessage</code> RPC is wrapped in
			<code>live.idempotent</code>, so a retried call (reconnect,
			double-click) lands exactly one message. See
			<a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/chat.js">chat.js</a>.
		</p>
		<p>
			The members-only room is denied at the wire: the app's
			<code>subscribe</code> hook in <code>hooks.ws.js</code> returns
			<code>FORBIDDEN</code> for its topics, the client's per-stream
			<code>error</code> readable renders the banner, and no message
			ever reaches the socket - the denial happens before any data is
			sent, not by filtering afterwards.
		</p>
	</aside>
</div>
