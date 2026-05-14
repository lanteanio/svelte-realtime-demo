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
					<div class="card-body">
						<div class="font-semibold">{room.label}</div>
						<div class="text-xs opacity-60">{room.desc}</div>
					</div>
				</a>
			</li>
		{/each}
	</ul>
</div>
