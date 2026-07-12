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
	import { kanban } from '$live/demos/kanban'

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
	$effect(() => () => board.destroy())

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

	function deleteCard(colId, index, id) {
		tryEdit(() => {
			board.transact(() => {
				orders[colId].delete(index)
				cards.delete(id)
			})
		})
	}

	// Replace-on-write: values are plain JSON, so a rename writes the
	// whole {title, color} record back under the same key.
	function renameCard(id, title) {
		tryEdit(() => {
			cards.set(id, { ...cards.get(id), title })
		})
	}
</script>

<div class="max-w-5xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Kanban: a shared CRDT document</h1>
		<p class="text-sm opacity-70 mt-1">
			One <code>live.doc</code>, zero RPC handlers. A
			<code>cards</code> map plus one order array per column; every
			edit applies to the local replica in the same tick and merges
			everywhere. Concurrent moves from two tabs both survive
			(per-element CRDT identity), and offline edits reconcile in one
			exchange on reconnect - the local replica IS the offline queue.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Editing as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono">({me.id.slice(0, 8)})</span>
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

	<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
							<li class="card bg-base-200" data-testid="kb-card-{id}">
								<div class="card-body p-2 gap-1">
									<div class="flex items-center gap-2">
										<span
											class="inline-block w-2 h-2 rounded-full shrink-0"
											style:background={card?.color ?? '#888888'}
										></span>
										<input
											class="input input-ghost input-xs flex-1 min-w-0 px-1"
											value={card?.title ?? ''}
											disabled={board.readOnly}
											oninput={(e) => renameCard(id, e.currentTarget.value)}
											data-testid="kb-title-{id}"
										/>
									</div>
									<div class="flex justify-between">
										<button
											class="btn btn-ghost btn-xs"
											onclick={() => moveCard(col.id, index, -1)}
											disabled={board.readOnly || col.id === COLUMN_IDS[0]}
											aria-label="Move left"
											data-testid="kb-move-left-{id}"
										>
											&larr;
										</button>
										<button
											class="btn btn-ghost btn-xs opacity-60"
											onclick={() => deleteCard(col.id, index, id)}
											disabled={board.readOnly}
											aria-label="Delete card"
											data-testid="kb-delete-{id}"
										>
											&#10005;
										</button>
										<button
											class="btn btn-ghost btn-xs"
											onclick={() => moveCard(col.id, index, 1)}
											disabled={board.readOnly || col.id === COLUMN_IDS[COLUMN_IDS.length - 1]}
											aria-label="Move right"
											data-testid="kb-move-right-{id}"
										>
											&rarr;
										</button>
									</div>
								</div>
							</li>
						{:else}
							<li class="opacity-40 text-xs text-center py-4">No cards</li>
						{/each}
					</ul>

					<form
						onsubmit={(e) => { e.preventDefault(); addCard(col.id) }}
						class="flex gap-1"
					>
						<input
							class="input input-bordered input-sm flex-1 min-w-0 bg-base-200"
							bind:value={drafts[col.id]}
							disabled={board.readOnly}
							placeholder="Add a card..."
							data-testid="kb-add-input-{col.id}"
						/>
						<button
							type="submit"
							class="btn btn-primary btn-sm"
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
