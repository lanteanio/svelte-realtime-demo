<!--
	/demos/kanban - one shared CRDT board via live.doc map/array facets.

	Three things to film here:

	1. Open two tabs. Add a card in one; it appears in the other with
	   no RPC, no publish call, no optimistic bookkeeping. The write
	   applied to the local replica and merged across.

	2. In tab A move a card right while tab B moves a DIFFERENT card
	   in the same column. Both moves survive - every array element
	   carries its own CRDT identity, so concurrent inserts and
	   deletes never shift each other's targets.

	3. DevTools-offline one tab, shuffle some cards, reconnect. The
	   local replica IS the offline queue: one state-vector exchange
	   uploads exactly what the server lacks and downloads exactly
	   what the tab missed. No replay list, no conflict dialog.

	Mechanism: `kanban.doc()` acquires the shared replica (reference
	counted - destroy() per component is safe). Named containers over
	one document: a 'cards' map (id -> {title, color}) and one order
	array per column. Reads are rune-backed and granular, so a title
	edit re-renders only that card. Multi-container edits (a move, a
	delete) wrap in doc.transact() = one atomic wire update.
-->
<script>
	import { SvelteSet } from 'svelte/reactivity'
	import { kanban } from '$live/demos/kanban'
	import { confirmDestructive } from '$lib/confirm-destructive'

	let { data } = $props()
	const me = $derived(data.identity)

	// One replica per page however many components mount it; the
	// $effect teardown releases this component's reference. The named
	// containers below are facets of the handle (they share its mount
	// and its update stream), so destroying the handle is the whole
	// cleanup.
	const board = kanban.doc()
	const cards = board.map('cards')
	const orders = {
		todo: board.array('order-todo'),
		doing: board.array('order-doing'),
		done: board.array('order-done')
	}
	$effect(() => () => {
		// Pending undo timers outlive the component otherwise, and their
		// callback writes to state this page no longer owns.
		for (const timer of undoTimers.values()) clearTimeout(timer)
		undoTimers.clear()
		board.destroy()
	})

	const COLUMN_IDS = ['todo', 'doing', 'done']
	const COLUMN_LABELS = { todo: 'Todo', doing: 'Doing', done: 'Done' }

	// toArray() is the reactive backing array; reading it inside
	// $derived re-renders the columns on every remote or local edit.
	const columns = $derived(COLUMN_IDS.map((id) => ({
		id,
		label: COLUMN_LABELS[id],
		cardIds: orders[id].toArray()
	})))

	let drafts = $state({ todo: '', doing: '', done: '' })
	let lastError = $state('')

	// Document mutators throw synchronously on a read-only mount (the
	// local view must never fork with edits the server would reject).
	// The guard grants everyone write, so this path only fires if that
	// changes; render it inline instead of letting it escape.
	function tryEdit(fn) {
		lastError = ''
		try { fn() } catch (err) { lastError = err?.message ?? String(err) }
	}

	function addCard(colId) {
		const title = drafts[colId].trim().slice(0, 120)
		if (!title) return
		const id = crypto.randomUUID()
		markLocal(id)
		tryEdit(() => {
			// Card body and column membership land as one wire update, so
			// a peer never sees an id whose card record is missing.
			board.transact(() => {
				cards.set(id, { title, color: me?.color ?? '#888888' })
				orders[colId].push(id)
			})
			drafts[colId] = ''
		})
	}

	function moveCard(fromCol, index, dir) {
		const toCol = COLUMN_IDS[COLUMN_IDS.indexOf(fromCol) + dir]
		if (!toCol) return
		const id = orders[fromCol].at(index)
		if (id === undefined) return
		markLocal(id)
		tryEdit(() => {
			// Atomic move: delete + insert in one transaction. Without the
			// transact a peer could briefly render the card in both columns
			// (or neither) between the two updates.
			board.transact(() => {
				orders[fromCol].delete(index)
				orders[toCol].push(id)
			})
		})
	}

	// A delete lands on every visitor's board at once, so it gets both halves
	// of Nielsen's pair: the confirm prevents the stray tap, and this window
	// repairs the deliberate one. The snapshot carries the card body, its
	// column and its index, which is what lets a restore land back where the
	// card was instead of at the end of some column.
	const UNDO_WINDOW_MS = 8000
	let pendingUndos = $state([])
	const undoTimers = new Map()

	function forgetUndo(token) {
		const timer = undoTimers.get(token)
		if (timer !== undefined) {
			clearTimeout(timer)
			undoTimers.delete(token)
		}
		pendingUndos = pendingUndos.filter((entry) => entry.token !== token)
	}

	function deleteCard(colId, index, id) {
		if (!confirmDestructive('Delete this card from the shared board?', { undoable: true })) return
		// Read the body BEFORE the transaction; afterwards the map no longer
		// has it, and an undo with no record would restore an empty card.
		const record = cards.get(id)
		tryEdit(() => {
			board.transact(() => {
				orders[colId].delete(index)
				cards.delete(id)
			})
			if (record === undefined) return
			const token = crypto.randomUUID()
			pendingUndos = [...pendingUndos, { token, id, record, colId, index }]
			undoTimers.set(token, setTimeout(() => forgetUndo(token), UNDO_WINDOW_MS))
		})
	}

	function undoDelete(token) {
		const entry = pendingUndos.find((item) => item.token === token)
		if (entry === undefined) return
		forgetUndo(entry.token)
		markLocal(entry.id)
		tryEdit(() => {
			const order = orders[entry.colId]
			// Peers keep editing during the undo window. Every element carries
			// its own CRDT identity, so the saved index is a position hint and
			// not a promise: clamp it to the column as it stands now, and never
			// add a second copy if the id is somehow already back.
			if (order.toArray().includes(entry.id)) return
			board.transact(() => {
				cards.set(entry.id, entry.record)
				order.insert(Math.min(entry.index, order.length), entry.id)
			})
		})
	}

	// Replace-on-write: values are plain JSON, so a rename writes the
	// whole {title, color} record back under the same key.
	function renameCard(id, title) {
		markLocal(id)
		tryEdit(() => {
			cards.set(id, { ...cards.get(id), title })
		})
	}

	// Renames commit on blur/Enter; while focused the input shows a local
	// draft, so a concurrent remote rename (map values are replace-on-write,
	// last-writer-wins) cannot clobber the caret mid-typing.
	let editingCardId = $state(null)
	let editingTitle = $state('')
	function beginRename(id) {
		editingCardId = id
		editingTitle = cards.get(id)?.title ?? ''
	}
	function commitRename(id) {
		if (editingCardId !== id) return
		const title = editingTitle.trim().slice(0, 120)
		editingCardId = null
		if (title && title !== cards.get(id)?.title) renameCard(id, title)
	}

	// Brief ring on cards a PEER just moved or renamed: diff each render's
	// membership+title signature against the previous one, skip ids this tab
	// touched in the last second, and highlight the rest for a moment.
	const remoteRing = new SvelteSet()
	const localTouch = new Map()
	function markLocal(id) { localTouch.set(id, Date.now()) }
	let prevSignatures = new Map()
	$effect(() => {
		const next = new Map()
		for (const col of columns) {
			for (const id of col.cardIds) next.set(id, col.id + ':' + (cards.get(id)?.title ?? ''))
		}
		const now = Date.now()
		const changed = []
		for (const [id, sig] of next) {
			const old = prevSignatures.get(id)
			if (old !== undefined && old !== sig && now - (localTouch.get(id) ?? 0) > 1000) changed.push(id)
		}
		prevSignatures = next
		if (changed.length > 0) {
			for (const id of changed) remoteRing.add(id)
			setTimeout(() => { for (const id of changed) remoteRing.delete(id) }, 1200)
		}
	})

	function seedSampleCards() {
		const samples = [
			{ col: 'todo', title: 'Open this page in a second tab' },
			{ col: 'doing', title: 'Move a card in each tab at once' },
			{ col: 'done', title: 'Watch both edits survive the merge' }
		]
		tryEdit(() => {
			board.transact(() => {
				for (const s of samples) {
					const id = crypto.randomUUID()
					markLocal(id)
					cards.set(id, { title: s.title, color: me?.color ?? '#888888' })
					orders[s.col].push(id)
				}
			})
		})
	}
</script>

<!-- The live region stays mounted and only its contents toggle: assistive tech
     binds a region when it enters the DOM and announces SUBSEQUENT mutations,
     so inserting the region and its text together announces unreliably. Same
     reasoning as /demos/pagination. pointer-events-none stops a lingering
     toast from swallowing clicks aimed at the board underneath it; the button
     takes its own events back. -->
<div class="toast toast-end z-50 pointer-events-none" role="status" aria-live="polite">
	{#each pendingUndos as undo (undo.token)}
		<div class="alert alert-warning py-2 px-3 text-sm shadow-lg gap-2" data-testid="kb-undo-toast">
			<span class="truncate max-w-[12rem]">Deleted "{undo.record.title}"</span>
			<button
				class="btn btn-xs pointer-events-auto pointer-coarse:min-h-11 pointer-coarse:min-w-11"
				onclick={() => undoDelete(undo.token)}
				data-testid="kb-undo-{undo.id}"
			>
				Undo
			</button>
		</div>
	{/each}
</div>

<div class="max-w-5xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Kanban: a shared CRDT document</h1>
		<p class="text-sm opacity-70 mt-1">
			One <code>live.doc</code>, zero RPC handlers. A
			<code>cards</code> map plus one order array per column; every
			edit applies to the local replica in the same tick and merges
			everywhere. Cards move between columns with their arrow buttons.
			Concurrent moves from two tabs both survive
			(per-element CRDT identity), and offline edits reconcile in one
			exchange on reconnect - the local replica IS the offline queue.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Editing as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono">({me.id.slice(0, 8)})</span>
				- cards carry their creator's color; a ring marks a peer's fresh edit
			</p>
		{/if}
	</header>

	<div class="flex items-center gap-2 text-xs">
		{#if board.synced}
			<span class="badge badge-success badge-sm" data-testid="kb-synced-badge">synced</span>
		{:else}
			<span class="badge badge-ghost badge-sm" data-testid="kb-syncing-badge">syncing...</span>
		{/if}
		{#if board.degraded}
			<span class="badge badge-warning badge-sm" data-testid="kb-degraded-badge">degraded - retrying sync</span>
		{/if}
		{#if board.readOnly}
			<span class="badge badge-neutral badge-sm" data-testid="kb-readonly-badge">read-only</span>
		{/if}
		{#if lastError}
			<span class="text-error" data-testid="kb-error">{lastError}</span>
		{/if}
	</div>

	{#if board.synced && columns.every((c) => c.cardIds.length === 0)}
		<div class="alert py-2 text-sm flex flex-wrap items-center gap-2" data-testid="kb-seed">
			<span>The shared board is empty.</span>
			<button class="btn btn-sm btn-primary" onclick={seedSampleCards} data-testid="kb-seed-button">
				Add sample cards
			</button>
			<span>then open this page in a second tab and move cards in both.</span>
		</div>
	{/if}

	<div class="grid grid-cols-1 @2xl:grid-cols-3 gap-4">
		{#each columns as col (col.id)}
			<section class="card bg-base-100 border border-base-300" data-testid="kb-col-{col.id}">
				<div class="card-body p-3 space-y-2">
					<h2 class="card-title text-sm justify-between">
						{col.label}
						<span class="badge badge-ghost badge-sm" data-testid="kb-count-{col.id}">{col.cardIds.length}</span>
					</h2>

					<ul class="space-y-2 min-h-[8rem]" data-testid="kb-cards-{col.id}">
						{#each col.cardIds as id, index (id)}
							{@const card = cards.get(id)}
							<li class="card bg-base-200 transition-shadow {remoteRing.has(id) ? 'ring-2 ring-primary/60' : ''}" data-testid="kb-card-{id}">
								<div class="card-body p-2 gap-1">
									<div class="flex items-center gap-2">
										<span
											class="inline-block w-2 h-2 rounded-full shrink-0"
											style:background={card?.color ?? '#888888'}
										></span>
										<!-- Per-card controls: compact on fine pointers, 44px where taps land. -->
										<input
											class="input input-ghost input-xs flex-1 min-w-0 px-1 pointer-coarse:min-h-11"
											value={editingCardId === id ? editingTitle : (card?.title ?? '')}
											disabled={board.readOnly}
											onfocus={() => beginRename(id)}
											oninput={(e) => { editingTitle = e.currentTarget.value }}
											onblur={() => commitRename(id)}
											onkeydown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
											aria-label="Card title"
											data-testid="kb-title-{id}"
										/>
									</div>
									<!-- Arrows pair up on the left; delete sits apart on the right so the
									     highest-frequency taps never bracket the destructive one. Below the
									     two-column rung the columns stack vertically, so the glyphs turn
									     vertical too - the action is the same "previous/next column" either way. -->
									<div class="flex gap-1">
										<button
											class="btn btn-ghost btn-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11"
											onclick={() => moveCard(col.id, index, -1)}
											disabled={board.readOnly || col.id === COLUMN_IDS[0]}
											aria-label="Move to previous column"
											data-testid="kb-move-left-{id}"
										>
											<span class="@2xl:hidden">&uarr;</span><span class="hidden @2xl:inline">&larr;</span>
										</button>
										<button
											class="btn btn-ghost btn-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11"
											onclick={() => moveCard(col.id, index, 1)}
											disabled={board.readOnly || col.id === COLUMN_IDS[COLUMN_IDS.length - 1]}
											aria-label="Move to next column"
											data-testid="kb-move-right-{id}"
										>
											<span class="@2xl:hidden">&darr;</span><span class="hidden @2xl:inline">&rarr;</span>
										</button>
										<button
											class="btn btn-ghost btn-xs ml-auto text-error/60 hover:text-error pointer-coarse:min-h-11 pointer-coarse:min-w-11"
											onclick={() => deleteCard(col.id, index, id)}
											disabled={board.readOnly}
											aria-label="Delete card"
											data-testid="kb-delete-{id}"
										>
											&#10005;
										</button>
									</div>
								</div>
							</li>
						{:else}
							<li class="text-base-content/70 text-xs text-center py-4">No cards - add one below.</li>
						{/each}
					</ul>

					<form
						onsubmit={(e) => { e.preventDefault(); addCard(col.id) }}
						class="flex gap-1"
					>
						<input
							class="input input-bordered input-sm flex-1 min-w-0 bg-base-200 pointer-coarse:min-h-11"
							bind:value={drafts[col.id]}
							disabled={board.readOnly}
							placeholder="Add a card..."
							aria-label="Add a card to {col.label}"
							data-testid="kb-add-input-{col.id}"
						/>
						<button
							type="submit"
							class="btn btn-primary btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11"
							disabled={board.readOnly || !drafts[col.id].trim()}
							data-testid="kb-add-button-{col.id}"
						>
							Add
						</button>
					</form>
				</div>
			</section>
		{/each}
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>export const kanban = live.doc(&#123; topic, guard &#125;)</code>
			- the whole file. No mutation handlers: document updates travel as
			opaque merge data, checked against the guard's access record, never
			as requests that could fail and need unwinding. Cluster convergence
			comes from <code>platform.crdt</code> wired app-wide in
			<code>hooks.ws.js</code>.
		</p>
		<p>
			Client: <code>kanban.doc()</code> returns the root handle;
			<code>board.map('cards')</code> and <code>board.array('order-*')</code>
			are named containers sharing one update stream. Mutations like
			<code>cards.set(id, &#123; ...cards.get(id), title &#125;)</code> apply
			synchronously; <code>board.transact(() =&gt; ...)</code> batches a
			move into one atomic wire update. <code>synced</code> /
			<code>degraded</code> / <code>readOnly</code> are live on the view.
			Source:
			<a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/kanban.js">src/live/demos/kanban.js</a>
		</p>
	</aside>
</div>
