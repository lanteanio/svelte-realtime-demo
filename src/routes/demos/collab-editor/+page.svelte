<!--
	/demos/collab-editor - CRDT-anchored selections vs raw offsets.

	Two multiplayer rooms, ONE shared live.doc. Both textareas bind to
	the same doc.text('body') facet, so the text under both panels is
	always identical - the only difference is the selection layer:

	- The Offset panel publishes raw { start, end } offsets. They are
	  frozen numbers: an edit before a remote selection shifts the text
	  but not the stored offsets, so the published range slides onto
	  the wrong characters. The offset wire passes the object verbatim,
	  so the panel also ships the text the range covered at publish
	  time - that is what lets a drifted row say so.
	- The CRDT panel binds the room to the document (room.bindDoc) and
	  publishes { field, start, end }; the range travels as a position
	  anchor inside the CRDT and room.selections re-resolves it against
	  the current text on every edit, so the range stays glued. The
	  anchor wire carries no app fields - it does not need a drift cue,
	  staying glued IS its proof.

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
	import { confirmDestructive } from '$lib/confirm-destructive'

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
	let localSelections = $state({ offset: null, crdt: null })

	/**
	 * Common prefix/suffix diff between two document values. Exact for the
	 * single-region edits a native input event produces, and the same
	 * splice a remote edit arrives as - which is what lets the caret
	 * mapping below ride on it too.
	 * @param {string} prev @param {string} next
	 */
	function diffSplice(prev, next) {
		let start = 0
		const maxStart = Math.min(prev.length, next.length)
		while (start < maxStart && prev[start] === next[start]) start++
		let prevEnd = prev.length
		let nextEnd = next.length
		while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
			prevEnd--
			nextEnd--
		}
		return { start, prevEnd, nextEnd }
	}

	/**
	 * Apply a textarea edit to the document as the minimal splice. The
	 * local write applies synchronously, so the re-rendered value equals
	 * the DOM value and the caret stays put.
	 * @param {Event} e
	 */
	function applyEdit(e) {
		const el = /** @type {HTMLTextAreaElement} */ (e.currentTarget)
		const next = el.value
		const prev = body.value
		if (next === prev) return
		const { start, prevEnd, nextEnd } = diffSplice(prev, next)
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

	// --- Caret preservation across remote edits ---
	// Assigning .value to a focused textarea throws the caret to the end -
	// mid-script, that feels like the editor fighting back. So the effect
	// below owns the textarea value outright (there is no template value
	// binding): it still sees the OLD DOM value and selection when a doc
	// change arrives, maps the selection through the incoming splice, and
	// writes value and caret in the same breath. A template binding would
	// write the value first and destroy the selection the mapping needs.
	// Local edits never diverge (the write is synchronous, so el.value
	// already equals the doc), which means only remote splices take the
	// mapping path.
	const textareaRefs = { offset: null, crdt: null }

	// selectionchange fires one coalesced event per task, including for
	// touch selection handles and for a tap that collapses a selection -
	// the per-element select/keyup/mouseup trio left phone visitors'
	// published ranges permanently stale in every other tab. The dedupe
	// key stops the same range from republishing on every keystroke.
	const lastPublished = { offset: undefined, crdt: undefined }

	function mapThroughSplice(pos, splice) {
		if (pos <= splice.start) return pos
		if (pos >= splice.prevEnd) return pos + (splice.nextEnd - splice.prevEnd)
		return splice.nextEnd
	}

	$effect(() => {
		const next = body.value
		for (const mode of ['offset', 'crdt']) {
			const el = textareaRefs[mode]
			if (!el || el.value === next) continue
			if (document.activeElement === el) {
				const splice = diffSplice(el.value, next)
				const start = mapThroughSplice(el.selectionStart ?? 0, splice)
				const end = mapThroughSplice(el.selectionEnd ?? 0, splice)
				el.value = next
				el.setSelectionRange(start, end)
				// The restore is local UX, not a new selection: swallow the
				// selectionchange it fires so the published range stays
				// frozen. Republishing the mapped offsets would quietly
				// un-drift the Offset panel exactly when its owner is
				// looking at it.
				lastPublished[mode] = start === end ? 'null' : `${start}:${end}`
			} else {
				el.value = next
			}
		}
	})

	/**
	 * Publish the local selection onto a room's roster. Offset mode sends
	 * the raw numbers plus the text they covered at publish time (extra
	 * fields ride the offset wire verbatim), so every panel can render
	 * selected-vs-now-covers and the drift declares itself; crdt mode
	 * names the text container so the range can anchor into the bound
	 * document. A collapsed caret clears the published selection so
	 * panels only show real ranges.
	 * @param {import('svelte-realtime/multiplayer').MultiplayerRoom} room
	 * @param {'offset' | 'crdt'} mode
	 * @param {HTMLTextAreaElement} el
	 */
	function publishSelection(room, mode, el) {
		const start = el.selectionStart ?? 0
		const end = el.selectionEnd ?? 0
		const key = start === end ? 'null' : `${start}:${end}`
		if (lastPublished[mode] === key) return
		lastPublished[mode] = key
		try {
			if (start === end) {
				room.setSelection(null)
				localSelections[mode] = null
			} else if (mode === 'crdt') {
				room.setSelection({ field: 'body', start, end })
				localSelections[mode] = { start, end }
			} else {
				const snippet = body.value.slice(start, end)
				room.setSelection({ start, end, snippet })
				localSelections[mode] = { start, end, snippet }
			}
		} catch (err) {
			editError = err?.message ?? String(err)
		}
	}

	function onSelectionChange() {
		for (const mode of ['offset', 'crdt']) {
			const el = textareaRefs[mode]
			if (el && document.activeElement === el) {
				publishSelection(mode === 'crdt' ? crdtView : offsetView, mode, el)
			}
		}
	}

	/**
	 * Flatten a room's remote selections into renderable rows. Reads
	 * room.selections, room.others, and body.value, so calling it from
	 * the template re-runs it on every roster push and every edit -
	 * which is exactly what makes the crdt panel's ranges re-glue and
	 * the offset panel's ranges visibly drift. A row whose publish-time
	 * snippet no longer matches the text its numbers cover is drifted -
	 * only offset rows can carry a snippet, so only they can drift.
	 * @param {import('svelte-realtime/multiplayer').MultiplayerRoom} room
	 * @param {'offset' | 'crdt'} mode
	 */
	function selectionRows(room, mode) {
		const text = body.value
		const rows = []
		const local = localSelections[mode]
		if (local) {
			const start = Math.max(0, Math.min(local.start, text.length))
			const end = Math.max(start, Math.min(local.end, text.length))
			if (end > start) {
				const covers = text.slice(start, end)
				rows.push({
					key: `local:${mode}`,
					name: me?.name ?? 'You',
					color: me?.color ?? '#888',
					start,
					end,
					snippet: covers,
					published: typeof local.snippet === 'string' ? local.snippet : undefined,
					local: true
				})
			}
		}
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
				snippet: text.slice(start, end),
				published: typeof sel.snippet === 'string' ? sel.snippet : undefined,
				local: false
			})
		}
		return rows
	}

	function clearDocument() {
		if (!confirmDestructive('Clear the shared collaborative document?')) return
		try {
			if (body.length > 0) body.delete(0, body.length)
			localSelections.offset = null
			localSelections.crdt = null
			editError = ''
		} catch (err) {
			editError = err?.message ?? String(err)
		}
	}

	const docLength = $derived(body.value.length)
	const pct = (n) => (100 * n) / Math.max(1, docLength)
	const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s)
</script>

<svelte:document onselectionchange={onSelectionChange} />

<div class="max-w-6xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Collab editor: selections that survive edits</h1>
		<p class="text-sm opacity-70 mt-1" data-testid="intro">
			Both panels edit the <em>same</em> <code>live.doc</code> text; only the
			selection layer differs. The <strong>Offset</strong> panel declares
			<code>selections: 'offset'</code>: raw <code>&#123; start, end &#125;</code>
			numbers stamped on the presence roster. The <strong>CRDT</strong> panel
			declares <code>selections: 'crdt'</code> and binds the room to the
			document via <code>room.bindDoc(doc)</code>, so a published range
			travels as a position anchor inside the CRDT. The selection rows under
			each panel are the proof: after an edit lands in front of a published
			range, the Offset panel's rows slide onto the wrong characters and say
			so, while the CRDT panel's rows stay glued to the original text. (Each
			panel is its own room, so a selection only shows up in the matching
			panel of the other tab.)
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Editing as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
			</p>
		{/if}
	</header>

	<ol class="text-sm opacity-80 list-decimal list-inside space-y-0.5" data-testid="collab-steps">
		<li>Open this page in a second tab.</li>
		<li>Here, select a word in <em>both</em> textareas - each panel publishes its own range.</li>
		<li>
			In the other tab, type in front of that word: the Offset row drifts and flags the
			mismatch, the CRDT row stays glued.
		</li>
	</ol>

	<div class="flex items-center gap-3 text-xs opacity-60">
		<span data-testid="collab-doc-length">{docLength} chars</span>
		<span data-testid="collab-doc-synced">{doc.synced ? 'synced' : 'syncing...'}</span>
		<button
			class="btn btn-outline btn-error btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11"
			onclick={clearDocument}
			data-testid="collab-clear"
		>
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
					oninput={applyEdit}
					bind:this={textareaRefs[mode]}
					data-testid="{testPrefix}-textarea"
				></textarea>
				<div class="text-xs opacity-60">
					{room.others.length}
					{room.others.length === 1 ? 'other person' : 'others'} in this room
				</div>
				<div class="space-y-2" data-testid="{testPrefix}-selections">
					{#each selectionRows(room, mode) as row (row.key)}
						<div
							class="text-xs space-y-1 rounded px-2 py-1 {row.local ? 'border border-primary/40 bg-primary/10' : ''}"
							data-testid="{testPrefix}-selection-row"
							data-local={row.local ? 'true' : 'false'}
						>
							<div class="flex items-baseline gap-2 flex-wrap">
								<span class="font-semibold" style:color={row.color}>{row.name}</span>
								{#if row.local}<span class="badge badge-primary badge-xs">you</span>{/if}
								<span class="font-mono opacity-60">[{row.start}, {row.end})</span>
								{#if row.published !== undefined && row.published !== row.snippet}
									<span class="truncate opacity-70">selected "{clip(row.published)}"</span>
									<span class="text-warning font-medium" data-testid="{testPrefix}-selection-drift">
										now covers "{clip(row.snippet)}"
									</span>
								{:else}
									<span class="truncate opacity-70">"{clip(row.snippet)}"</span>
								{/if}
							</div>
							<div class="relative h-2 rounded bg-base-300 overflow-hidden">
								<div
									class="absolute inset-y-0 rounded"
									style="left: {pct(row.start)}%; width: {Math.max(0.5, pct(row.end - row.start))}%; background: {row.color}"
								></div>
							</div>
						</div>
					{:else}
						<p class="text-sm opacity-70" data-testid="{testPrefix}-selections-empty">
							Select text in the box above - or open a second tab and select there - and the
							range lands here as a row.
						</p>
					{/each}
				</div>
			</div>
		</section>
	{/snippet}

	<div class="grid grid-cols-1 @5xl:grid-cols-2 gap-4">
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
			anchor against the bound document reactively, so ranges
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
