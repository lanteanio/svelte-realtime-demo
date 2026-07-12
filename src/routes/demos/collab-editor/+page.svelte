<!--
	/demos/collab-editor - CRDT-anchored selections vs raw offsets.

	Two multiplayer rooms, ONE shared live.doc. Both textareas bind to
	the same doc.text('body') facet, so the text under both panels is
	always identical - the only difference is the selection layer:

	- The offset panel publishes raw { start, end } offsets. They are
	  frozen numbers: an edit before a remote selection shifts the text
	  but not the stored offsets, so the highlight drifts.
	- The CRDT panel binds the room to the document (room.bindDoc) and
	  publishes { field, start, end }; the range travels as a position
	  anchor inside the CRDT and room.selections re-resolves it against
	  the current text on every edit, so the highlight stays glued.

	Edits are applied as the minimal splice: the input handler diffs
	the previous document value against the new textarea value by
	common prefix/suffix. A native textarea input event is always a
	single-region edit (typing, deleting, or pasting over a selection),
	so one delete+insert pair reproduces it exactly - replacing the
	whole text on every keystroke would work too, but it would turn
	every keystroke into a full-document rewrite and defeat the point
	of character-level merging.
-->
<script>
	import { editorDoc, offsetRoom, crdtRoom } from '$live/demos/collab-editor'

	let { data } = $props()
	const me = $derived(data.identity)

	// One shared replica: both panels read and write the same DocText.
	// The handle is reference-counted, so one acquire + one destroy.
	const doc = editorDoc.doc()
	const body = doc.text('body')

	// Name the local user once per namespace; me + self-exclusion light
	// up on both rooms' rosters.
	offsetRoom.identify(data.identity.id)
	crdtRoom.identify(data.identity.id)

	const offsetView = offsetRoom.room()
	// bindDoc wires the crdt selection layer to the document the
	// selections index into; without it a crdt setSelection is dropped.
	const crdtView = crdtRoom.room().bindDoc(doc)

	$effect(() => () => {
		offsetView.destroy()
		crdtView.destroy()
		doc.destroy()
	})

	let editError = $state('')

	/**
	 * Apply a textarea edit to the document as the minimal splice.
	 * Common prefix/suffix diff: exact for the single-region edits a
	 * native input event produces. The local write applies
	 * synchronously, so the re-rendered value equals the DOM value and
	 * the caret stays put; a REMOTE edit landing mid-keystroke can
	 * still move the caret to the end (acceptable for a demo textarea).
	 * @param {Event} e
	 */
	function applyEdit(e) {
		const el = /** @type {HTMLTextAreaElement} */ (e.currentTarget)
		const next = el.value
		const prev = body.value
		if (next === prev) return
		let start = 0
		const maxStart = Math.min(prev.length, next.length)
		while (start < maxStart && prev[start] === next[start]) start++
		let prevEnd = prev.length
		let nextEnd = next.length
		while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
			prevEnd--
			nextEnd--
		}
		try {
			doc.transact(() => {
				if (prevEnd > start) body.delete(start, prevEnd - start)
				if (nextEnd > start) body.insert(start, next.slice(start, nextEnd))
			})
			editError = ''
		} catch (err) {
			editError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		}
	}

	/**
	 * Publish the local selection onto a room's roster. Offset mode
	 * sends the raw numbers; crdt mode names the text container so the
	 * range can anchor into the bound document. A collapsed caret
	 * clears the published selection so panels only show real ranges.
	 * @param {import('svelte-realtime/multiplayer').MultiplayerRoom} room
	 * @param {'offset' | 'crdt'} mode
	 * @param {Event} e
	 */
	function reportSelection(room, mode, e) {
		const el = /** @type {HTMLTextAreaElement} */ (e.currentTarget)
		const start = el.selectionStart ?? 0
		const end = el.selectionEnd ?? 0
		try {
			if (start === end) {
				room.setSelection(null)
			} else if (mode === 'crdt') {
				room.setSelection({ field: 'body', start, end })
			} else {
				room.setSelection({ start, end })
			}
		} catch (err) {
			editError = err?.message ?? String(err)
		}
	}

	/**
	 * Flatten a room's remote selections into renderable rows. Reads
	 * room.selections, room.others, and body.value, so calling it from
	 * the template re-runs it on every roster push and every edit -
	 * which is exactly what makes the crdt panel's highlights re-glue
	 * and the offset panel's highlights visibly drift.
	 * @param {import('svelte-realtime/multiplayer').MultiplayerRoom} room
	 */
	function selectionRows(room) {
		const text = body.value
		const rows = []
		for (const [key, sel] of Object.entries(room.selections)) {
			if (!sel || typeof sel.start !== 'number' || typeof sel.end !== 'number') continue
			if (sel.field && sel.field !== 'body') continue
			// Offset mode can point past the end after deletions; clamp so
			// the drift renders as a wrong-but-visible bar, never a crash.
			const start = Math.max(0, Math.min(sel.start, text.length))
			const end = Math.max(start, Math.min(sel.end, text.length))
			const peer = room.others.find((p) => p.key === key)
			rows.push({
				key,
				name: peer?.data?.name ?? 'peer',
				color: peer?.color ?? '#888',
				start,
				end,
				snippet: text.slice(start, end)
			})
		}
		return rows
	}

	function clearDocument() {
		try {
			if (body.length > 0) body.delete(0, body.length)
			editError = ''
		} catch (err) {
			editError = err?.message ?? String(err)
		}
	}

	const docLength = $derived(body.value.length)
	const pct = (n) => (100 * n) / Math.max(1, docLength)
</script>

<div class="max-w-6xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Collab editor: selections that survive edits</h1>
		<p class="text-sm opacity-70 mt-1">
			Both panels edit the <em>same</em> <code>live.doc</code> text; only the
			selection layer differs. The left room declares
			<code>selections: 'offset'</code> (raw <code>&#123; start, end &#125;</code>
			stamped on the presence roster), the right one
			<code>selections: 'crdt'</code> bound to the document via
			<code>room.bindDoc(doc)</code>. Try it in two tabs: select a word in
			tab A, then type text <em>before</em> it in tab B - the offset
			panel's highlight drifts onto the wrong characters, the CRDT
			panel's stays glued to the word.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Editing as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
			</p>
		{/if}
	</header>

	<div class="flex items-center gap-3 text-xs opacity-60">
		<span data-testid="collab-doc-length">{docLength} chars</span>
		<span data-testid="collab-doc-synced">{doc.synced ? 'synced' : 'syncing...'}</span>
		<button class="btn btn-ghost btn-xs" onclick={clearDocument} data-testid="collab-clear">
			Clear document
		</button>
		{#if editError}
			<span class="text-error" data-testid="collab-error">{editError}</span>
		{/if}
	</div>

	{#snippet panel(mode, title, room, testPrefix)}
		<section class="card bg-base-200" data-testid="{testPrefix}-panel">
			<div class="card-body py-3 space-y-2">
				<h2 class="card-title text-sm">
					{title}
					<span class="badge badge-ghost badge-xs font-mono">selections: '{mode}'</span>
				</h2>
				<textarea
					class="textarea textarea-bordered w-full h-40 font-mono text-sm leading-relaxed"
					spellcheck="false"
					maxlength="4000"
					placeholder="Type here - the other panel (and every other tab) sees the same text."
					value={body.value}
					oninput={applyEdit}
					onselect={(e) => reportSelection(room, mode, e)}
					onkeyup={(e) => reportSelection(room, mode, e)}
					onmouseup={(e) => reportSelection(room, mode, e)}
					data-testid="{testPrefix}-textarea"
				></textarea>
				<div class="text-xs opacity-60">
					{room.others.length}
					{room.others.length === 1 ? 'other person' : 'others'} in this room
				</div>
				<div class="space-y-2" data-testid="{testPrefix}-selections">
					{#each selectionRows(room) as row (row.key)}
						<div class="text-xs space-y-1" data-testid="{testPrefix}-selection-row">
							<div class="flex items-baseline gap-2">
								<span class="font-semibold" style:color={row.color}>{row.name}</span>
								<span class="font-mono opacity-60">[{row.start}, {row.end})</span>
								<span class="truncate opacity-70">"{row.snippet.slice(0, 40)}{row.snippet.length > 40 ? '...' : ''}"</span>
							</div>
							<div class="relative h-2 rounded bg-base-300 overflow-hidden">
								<div
									class="absolute inset-y-0 rounded"
									style="left: {pct(row.start)}%; width: {Math.max(0.5, pct(row.end - row.start))}%; background: {row.color}"
								></div>
							</div>
						</div>
					{:else}
						<p class="text-xs opacity-40" data-testid="{testPrefix}-selections-empty">
							No remote selections. Open a second tab and select some text there.
						</p>
					{/each}
				</div>
			</div>
		</section>
	{/snippet}

	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		{@render panel('offset', 'Offset selections (drift)', offsetView, 'collab-offset')}
		{@render panel('crdt', 'CRDT selections (glued)', crdtView, 'collab-crdt')}
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: one <code>live.doc</code> export both panels bind their
			textarea to (<code>doc.text('body')</code>, persisted as a
			compacted CRDT snapshot in Redis), plus two
			<code>live.multiplayer</code> exports that differ only in
			<code>selections: 'offset'</code> vs <code>selections: 'crdt'</code>.
			Selections are presence fields, so both rooms declare
			<code>presence</code>; ranges are published with
			<code>room.setSelection(...)</code> and read back from
			<code>room.selections</code>. The crdt room resolves each peer's
			anchor against the bound document reactively, so highlights
			re-resolve on every edit.
		</p>
		<p>
			Edits go through <code>doc.transact()</code> as a minimal
			delete+insert splice; local writes apply synchronously and merge
			everywhere without a server round trip deciding a winner. See
			<a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/collab-editor.js">collab-editor.js</a>.
		</p>
	</aside>
</div>
