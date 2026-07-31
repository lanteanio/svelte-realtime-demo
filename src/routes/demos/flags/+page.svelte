<!--
	/demos/flags: live feature flags.

	Two flags declared with live.flag on the server. Card 1 is the
	operator surface: every change calls the setFlag RPC, the server
	validates and calls flag.set(value), and the new value is pushed
	to EVERY connected client instantly (and replays cluster-latest
	to fresh connects). Card 2 is the user surface: it renders the
	live flag values as a promo banner and a gradual-rollout checkout
	tile.

	The rollout BUCKETING is client-side demo logic (a stable hash of
	the identity id into 0-99); the flag VALUE is the server-pushed
	part. A real app can bucket wherever it likes - the flag store
	just delivers the current value everywhere.
-->
<script>
	import { banner, darkLaunch, setFlag } from '$live/demos/flags'

	let { data } = $props()
	const me = $derived(data.identity)

	// Flags are live wire state read straight off the store: $banner /
	// $darkLaunch auto-subscribe, SSR renders realtime's readable stub and
	// the client hydrates the server-pushed value. Cards render their real
	// controls once the first value arrives (the `ready` gate below).
	const bannerError = banner.error
	const darkError = darkLaunch.error
	const ready = $derived($banner !== undefined && $darkLaunch !== undefined)

	let opError = $state(null)
	const flagError = $derived($bannerError ?? $darkError ?? null)

	// Operator drafts: each flag's controls send the full draft, so two
	// quick edits to different fields of the same flag never clobber
	// each other while a confirm is still in flight. The drafts sync
	// back from every server-pushed value (including other operators').
	let bannerDraft = $state({ enabled: false, text: '' })
	let darkDraft = $state({ enabled: false, rolloutPct: 0 })
	$effect(() => { if ($banner) bannerDraft = { ...$banner } })
	$effect(() => { if ($darkLaunch) darkDraft = { ...$darkLaunch } })

	async function commit(name, value) {
		opError = null
		try {
			await setFlag(name, value)
		} catch (err) {
			opError = `${err?.code ?? 'ERROR'}: ${err?.message ?? err}`
		}
	}

	function toggleBanner(enabled) {
		bannerDraft.enabled = enabled
		commit('banner', { ...bannerDraft })
	}

	function commitBannerText(text) {
		bannerDraft.text = text
		commit('banner', { ...bannerDraft })
	}

	function toggleDark(enabled) {
		darkDraft.enabled = enabled
		commit('dark-launch', { ...darkDraft })
	}

	function commitRollout() {
		commit('dark-launch', { ...darkDraft })
	}

	// Stable per-identity bucket in 0-99 (FNV-1a over the identity id).
	// CLIENT-side demo logic: the server pushes the flag value, the
	// client decides which cohort this identity falls into.
	function bucketOf(id) {
		let h = 0x811c9dc5
		const s = String(id ?? '')
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i)
			h = Math.imul(h, 0x01000193)
		}
		return (h >>> 0) % 100
	}

	const bucket = $derived(bucketOf(me?.id))
	const showNewCheckout = $derived(
		Boolean($darkLaunch?.enabled) && bucket < ($darkLaunch?.rolloutPct ?? 0)
	)
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Feature flags: flip once, everywhere</h1>
		<p class="text-sm opacity-70 mt-1">
			Two <code>live.flag</code> declarations on the server. The
			operator card calls a <code>setFlag</code> RPC that validates
			and runs <code>flag.set(value)</code>; the new value reaches
			every connected client instantly and replays cluster-latest to
			fresh connects. The user card renders the live result - open a
			second tab and flip a toggle to watch both update together.
		</p>
	</header>

	<!-- Operator card -->
	<section class="card bg-base-200" data-testid="fl-operator-card">
		<div class="card-body py-3 space-y-3">
			<h2 class="card-title text-sm">You are the operator</h2>

			<div class="flex flex-wrap items-end gap-4">
				<!-- Compact dress on fine pointers, 44px floor where taps land; the
				     label is the toggle's tap surface, so it carries the floor. -->
				<label class="flex items-center gap-2 cursor-pointer pointer-coarse:min-h-11">
					<input
						type="checkbox"
						class="toggle toggle-primary toggle-sm"
						checked={bannerDraft.enabled}
						disabled={!ready}
						onchange={(e) => toggleBanner(e.currentTarget.checked)}
						data-testid="fl-banner-toggle"
					/>
					<span class="text-sm">Promo banner</span>
				</label>
				<label class="form-control flex-1 min-w-[14rem]">
					<span class="label-text text-xs">Banner text (commits on blur / Enter)</span>
					<input
						class="input input-bordered input-sm pointer-coarse:min-h-11"
						value={bannerDraft.text}
						maxlength="120"
						disabled={!ready}
						onchange={(e) => commitBannerText(e.currentTarget.value)}
						data-testid="fl-banner-text"
					/>
				</label>
			</div>

			<div class="flex flex-wrap items-end gap-4">
				<label class="flex items-center gap-2 cursor-pointer pointer-coarse:min-h-11">
					<input
						type="checkbox"
						class="toggle toggle-primary toggle-sm"
						checked={darkDraft.enabled}
						disabled={!ready}
						onchange={(e) => toggleDark(e.currentTarget.checked)}
						data-testid="fl-dark-toggle"
					/>
					<span class="text-sm">Dark-launch: new checkout</span>
				</label>
				<label class="form-control flex-1 min-w-[14rem]">
					<span class="label-text text-xs">
						Rollout: <span class="font-mono" data-testid="fl-rollout-value">{darkDraft.rolloutPct}%</span>
					</span>
					<input
						type="range"
						class="range range-primary range-sm pointer-coarse:range-lg pointer-coarse:min-h-11"
						min="0"
						max="100"
						step="1"
						bind:value={darkDraft.rolloutPct}
						disabled={!ready}
						onchange={commitRollout}
						data-testid="fl-rollout"
					/>
				</label>
			</div>

			{#if !ready}
				<p class="text-xs opacity-40" data-testid="fl-loading">Loading flag values...</p>
			{/if}
			{#if opError}
				<div class="text-xs text-error" data-testid="fl-op-error">{opError}</div>
			{/if}
			{#if flagError}
				<div class="text-xs text-error" data-testid="fl-flag-error">
					{flagError.code ?? 'ERROR'}: {flagError.message ?? 'Flag subscribe failed'}
				</div>
			{/if}
		</div>
	</section>

	<!-- User card -->
	<section class="card bg-base-100 border border-base-300" data-testid="fl-user-card">
		<div class="card-body py-3 space-y-3">
			<h2 class="card-title text-sm">You are the user</h2>

			{#if $banner?.enabled}
				<div class="alert alert-info py-2" data-testid="fl-promo-banner">
					<span class="font-semibold">{$banner.text}</span>
				</div>
			{:else}
				<div class="text-xs opacity-40 border border-dashed border-base-300 rounded p-2" data-testid="fl-promo-off">
					No promo running. Toggle the banner flag above.
				</div>
			{/if}

			<div
				class="rounded border p-4 flex items-center justify-between gap-4"
				class:border-primary={showNewCheckout}
				class:border-base-300={!showNewCheckout}
				data-testid="fl-checkout-tile"
			>
				<div>
					{#if showNewCheckout}
						<div class="font-semibold text-primary">New checkout</div>
						<div class="text-xs opacity-60">One-click flow, dark-launched to your cohort.</div>
					{:else}
						<div class="font-semibold">Old checkout</div>
						<div class="text-xs opacity-60">The battle-tested three-step flow.</div>
					{/if}
				</div>
				<div class="text-right text-xs opacity-50">
					<div>your bucket: <span class="font-mono" data-testid="fl-bucket">{bucket}</span> / 99</div>
					<div>rollout: <span class="font-mono">{$darkLaunch?.rolloutPct ?? 0}%</span> {$darkLaunch?.enabled ? '' : '(off)'}</div>
				</div>
			</div>
			<p class="text-xs opacity-50">
				Bucketing is client-side demo logic: a stable hash of your
				identity id into 0-99, shown new when
				<code>bucket &lt; rolloutPct</code>. The server-pushed part is
				the flag value itself.
			</p>
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>banner = live.flag('demos:flags:banner', &#123; enabled, text &#125;)</code>
			and <code>darkLaunch = live.flag('demos:flags:dark-launch', &#123; enabled, rolloutPct &#125;)</code>
			- each a thin wrapper over a <code>merge: 'set'</code> stream.
			The <code>setFlag</code> RPC allowlists the flag name, validates
			the value shape, then calls <code>.set(value)</code>; a real app
			gates that behind admin auth. See
			<a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/flags.js">flags.js</a>.
		</p>
		<p>
			Cluster: flags are cluster-consistent by default - a
			single-entry shared replay buffer (size 1) means
			<code>.set()</code> on any replica writes the shared buffer, and
			a client that connects fresh to any replica is served the
			cluster-latest value; already-subscribed clients stay in sync as
			the set relays over the bus.
		</p>
	</aside>
</div>
