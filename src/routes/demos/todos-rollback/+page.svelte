<!--
	/demos/todos-rollback - optimistic mutate + concurrent-failure rollback.

	Three things to film here:

	1. Add a few todos with "Force fail" OFF. Items appear instantly
	   (optimistic), then the server confirms by id. Smooth.

	2. Flip "Force fail" ON. Add a todo. Watch the placeholder appear,
	   then disappear when the server rejects with FORCED. The error
	   toast names the cause.

	3. Click "Spam x5" with Force fail ON. Five placeholders appear
	   instantly, then disappear independently as five FORCED errors
	   land. No phantom traces; the displayed list returns cleanly to
	   server state. This is the always-on queue-replay rewrite from
	   realtime doing its job.

	Mechanism: rpc.createOptimistic(store, callArgs, change) ties the
	UI mutation to the RPC. Rollback happens automatically on reject.
	The client generates each todo id; the server's confirming event
	matches by key (crud merge), so the placeholder absorbs cleanly
	with no flicker.
-->
<script>
	import { todosStream, addTodo, toggleTodo, removeTodo, clearAll } from '$live/demos/todos-rollback'
	import { confirmDestructive } from '$lib/confirm-destructive'

	let todos = $state([])
	let hydrated = $state(false)
	$effect(() => {
		const off = todosStream.subscribe((v) => { todos = v ?? []; hydrated = true })
		return () => off()
	})

	let draft = $state('')
	let forceFail = $state(false)

	// Identical failures collapse into one counted row rather than stacking.
	// "Spam x5" under Force fail produced five simultaneous alerts, and five
	// stacked alerts cover the lower half of a phone viewport - including the
	// Todos card - during exactly the seconds the placeholders vanish. The
	// feedback was destroying the view it reports on, and five copies of one
	// sentence say nothing the count does not.
	//
	// Coalescing keys on the CAUSE, not on the label. "Spam x5" labels its five
	// calls "Spam 1".."Spam 5", so keying on the whole message would leave five
	// rows that differ only by a number nobody needs - the reader wants to know
	// what was rejected and how many, and the count carries the multiplicity
	// better than five near-identical sentences do.
	// Removal keys on the id, never on object identity. `toasts` is $state, so
	// what the array holds is a PROXY of the object that went in - and a timer
	// closing over the raw object compares proxy against raw, matches nothing,
	// and filters nothing, leaving that toast on screen forever. It hid because
	// the coalescing path happens to work: `existing` comes out of
	// `toasts.find(...)`, so it is already the proxy and compares equal. Only a
	// lone toast - one error, never repeated - was stranded.
	let toasts = $state([])
	const dropToast = (id) => { toasts = toasts.filter((t) => t.id !== id) }
	function pushToast(label, cause) {
		const existing = toasts.find((t) => t.cause === cause)
		if (existing) {
			// Re-arm the timer as well as the count: a burst that keeps arriving
			// must not expire on the first one's clock.
			clearTimeout(existing.timer)
			existing.count += 1
			existing.timer = setTimeout(() => dropToast(existing.id), TOAST_MS)
			return
		}
		const entry = { id: crypto.randomUUID(), label, cause, count: 1, timer: null }
		entry.timer = setTimeout(() => dropToast(entry.id), TOAST_MS)
		toasts = [...toasts, entry]
	}

	const TOAST_MS = 3500

	async function tryMutate(label, fn) {
		try { await fn() }
		catch (err) { pushToast(label, `${err?.code ?? 'ERROR'} - ${err?.message ?? err}`) }
	}

	async function handleAdd() {
		if (!draft.trim()) return
		const id = crypto.randomUUID()
		const text = draft
		draft = ''
		await tryMutate('Add', () =>
			addTodo.createOptimistic(
				todosStream,
				[{ id, text, forceFail }],
				(current) => [...current, { id, text, done: false, ts: Date.now() }]
			)
		)
	}

	async function handleSpamFive() {
		const baseText = draft.trim() || 'spam'
		draft = ''
		const calls = Array.from({ length: 5 }, (_, i) => {
			const id = crypto.randomUUID()
			const text = `${baseText}-${i + 1}`
			return tryMutate(`Spam ${i + 1}`, () =>
				addTodo.createOptimistic(
					todosStream,
					[{ id, text, forceFail }],
					(current) => [...current, { id, text, done: false, ts: Date.now() }]
				)
			)
		})
		await Promise.all(calls)
	}

	async function handleToggle(todo) {
		await tryMutate('Toggle', () =>
			toggleTodo.createOptimistic(
				todosStream,
				[{ id: todo.id, forceFail }],
				(current) => current.map((t) => t.id === todo.id ? { ...t, done: !t.done } : t)
			)
		)
	}

	async function handleRemove(todo) {
		await tryMutate('Remove', () =>
			removeTodo.createOptimistic(
				todosStream,
				[{ id: todo.id, forceFail }],
				(current) => current.filter((t) => t.id !== todo.id)
			)
		)
	}

	async function handleClear() {
		if (!confirmDestructive('Clear the shared todo list?')) return
		await tryMutate('Clear all', () => clearAll())
	}
</script>

<div class="max-w-2xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Optimistic mutate with rollback</h1>
		<p class="text-sm opacity-70 mt-1">
			Each add, toggle, and remove applies optimistically and rolls
			back independently when the server says no. Flip
			<code>Force fail</code> on, then "Spam x5": five placeholders
			appear and disappear cleanly. No phantom traces.
		</p>
	</header>

	<div class="card bg-base-200">
		<div class="card-body py-3">
			<label class="label cursor-pointer justify-start gap-3">
				<input
					type="checkbox"
					class="toggle toggle-warning"
					bind:checked={forceFail}
					data-testid="force-fail-toggle"
				/>
				<!-- daisyUI 5 .label sets white-space: nowrap; without the
				     override this caption clips mid-word below 640px. -->
				<span class="opacity-70 whitespace-normal">
					<strong>Force fail</strong> - when on, every mutate
					rejects with <code>LiveError('FORCED')</code>.
				</span>
			</label>
		</div>
	</div>

	<!-- The row used to be non-wrapping, so at 320 the input collapsed to about
	     70px and its placeholder truncated mid-word: the act every step of this
	     page begins with happened in the smallest target on the screen. The
	     input now takes a full line of its own until there is room for the
	     buttons beside it, which is what basis-full plus a wrapping row buys
	     without a second breakpoint to keep in sync. -->
	<form onsubmit={(e) => { e.preventDefault(); handleAdd() }} class="flex flex-wrap gap-2">
		<!-- Compact on fine pointers, 44px where taps land; the row checkbox holds the 24px WCAG AA floor. -->
		<label class="sr-only" for="todo-input">New todo</label>
		<input
			id="todo-input"
			class="input input-bordered basis-full @sm:basis-0 @sm:flex-1 min-w-0 pointer-coarse:min-h-11"
			bind:value={draft}
			placeholder="Add a todo..."
			data-testid="todo-input"
		/>
		<button type="submit" class="btn btn-primary flex-1 @sm:flex-none pointer-coarse:min-h-11 pointer-coarse:min-w-11" disabled={!draft.trim()} data-testid="add-button">
			Add
		</button>
		<button
			type="button"
			class="btn btn-warning flex-1 @sm:flex-none"
			onclick={handleSpamFive}
			data-testid="spam-button"
		>
			Spam x5
		</button>
	</form>

	<div class="card bg-base-100 border border-base-300 min-h-[16rem]">
		<div class="card-body py-3">
			<div class="flex justify-between items-center">
				<h2 class="card-title text-sm">Todos ({todos.length})</h2>
				{#if todos.length > 0}
					<button class="btn btn-outline btn-error btn-xs" onclick={handleClear} data-testid="clear-button">
						Clear all
					</button>
				{/if}
			</div>
			<ul class="space-y-1 text-sm" data-testid="todos" data-hydrated={hydrated}>
				{#each todos as todo (todo.id)}
					<li class="flex items-center gap-2">
						<!-- Every control here names what it acts on. The checkbox and
						     the remove glyph had no accessible name at all, so a
						     screen reader announced a row of unlabelled controls and
						     the todo's own text was the only way to tell them apart -
						     which is exactly what a name is for. -->
						<input
							type="checkbox"
							class="checkbox checkbox-sm pointer-coarse:checkbox-md"
							checked={todo.done}
							onchange={() => handleToggle(todo)}
							aria-label="Done: {todo.text}"
							data-testid="todo-toggle-{todo.id}"
						/>
						<span class:line-through={todo.done} class:opacity-60={todo.done} class="flex-1">
							{todo.text}
						</span>
						<button
							class="btn btn-ghost btn-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11"
							onclick={() => handleRemove(todo)}
							aria-label="Remove: {todo.text}"
							data-testid="todo-remove-{todo.id}"
						>
							<span aria-hidden="true">✕</span>
						</button>
					</li>
				{:else}
					<li class="opacity-40 text-center py-6">No todos yet. Add one above.</li>
				{/each}
			</ul>
		</div>
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: each handler is plain <code>live(async (ctx, args) =&gt; ...)</code>.
			With <code>forceFail</code> in the args, the handler throws
			<code>LiveError('FORCED', ...)</code> immediately.
		</p>
		<p>
			Client: <code>addTodo.createOptimistic(store, [args], change)</code>
			applies <code>change</code> to the displayed value, runs the RPC,
			and on reject rolls back the change. The displayed value is
			recomputed by replaying any other in-flight mutations against the
			latest server state, so concurrent failures don't smear each
			other.
		</p>
	</aside>

	{#if toasts.length > 0}
		<div class="toast toast-end z-50">
			<!-- max-w-md is 448px, wider than every phone rung this page is read
			     on, so a long message ran off the side of the screen it was
			     supposed to be reporting to. Clamped to the viewport with the
			     toast's own gutter subtracted. -->
			{#each toasts as toast (toast.id)}
				<div class="alert alert-error shadow-lg max-w-[calc(100vw-2rem)] @md:max-w-md" data-testid="todo-toast">
					<span class="text-xs" data-testid="todo-toast-text">
						{toast.count > 1 ? `${toast.count}x ` : `${toast.label}: `}{toast.cause}
					</span>
				</div>
			{/each}
		</div>
	{/if}
</div>
