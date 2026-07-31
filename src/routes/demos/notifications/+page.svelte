<!--
	/demos/notifications - live.push request/reply + cluster registry
	+ 6-field live.cron scheduler.

	Open this page in two tabs (separate identities). In tab A: pick the
	other user, type a message, hit Send. Tab B sees a card pop up with
	"Got it" / "Dismiss" buttons. Click one; tab A's send-result banner
	fills in with what tab B chose.

	With "schedule N seconds" set, the message lands in a queue that the
	server-side `live.cron('* * * * * *', ...)` tick drains every second.
	Cancel removes a pending entry before it fires.

	Three primitives in one page: live.push (request/reply), the
	extensions cluster connection registry (hidden but wired), and a
	6-field live.cron expression.
-->
<script>
	import { onMount, onDestroy } from 'svelte'
	import { presence } from 'svelte-adapter-uws/plugins/presence/client'
	import { onPush } from 'svelte-realtime/client'
	import {
		sendNotification,
		cancelScheduled,
		scheduledNotifications,
		recentActivity
	} from '$live/demos/notifications'

	let { data } = $props()
	const me = $derived(data.identity)

	// --- Recipient list from global presence ---
	const globalPresence = presence('global', { maxAge: 90000 })
	const recipients = $derived(($globalPresence ?? []).filter((u) => u.id !== me?.id))

	let selectedRecipientId = $state('')
	let text = $state('')
	let scheduleSec = $state(0)

	function stepSchedule(delta) {
		scheduleSec = Math.min(30, Math.max(0, scheduleSec + delta))
	}
	let busy = $state(false)
	let outcome = $state(null) // { kind: 'delivered'|'dismissed'|'timeout'|'offline'|'error'|'scheduled', detail?: string }

	// Auto-pick the first recipient when the list changes and current pick is gone.
	$effect(() => {
		if (recipients.length === 0) {
			selectedRecipientId = ''
			return
		}
		if (!recipients.find((u) => u.id === selectedRecipientId)) {
			selectedRecipientId = recipients[0].id
		}
	})

	// --- Inbox: incoming pushes waiting for the user to ack ---
	/** @type {{ id: string, fromUserName: string, fromUserColor: string, text: string, sentAt: number, resolve: (v: any) => void }[]} */
	let incoming = $state([])

	let unregisterPush = null
	onMount(() => {
		unregisterPush = onPush('demos:notification', (data) => {
			return new Promise((resolve) => {
				const card = {
					id: data.id,
					fromUserName: data.fromUserName,
					fromUserColor: data.fromUserColor,
					text: data.text,
					sentAt: data.sentAt,
					resolve
				}
				incoming = [...incoming, card]
			})
		})
	})
	onDestroy(() => {
		unregisterPush?.()
	})

	function ackIncoming(cardId, ack) {
		const card = incoming.find((c) => c.id === cardId)
		if (!card) return
		card.resolve({ ack })
		incoming = incoming.filter((c) => c.id !== cardId)
	}

	// --- Scheduled queue + activity log ---
	let scheduledList = $state([])
	let activityList = $state([])

	$effect(() => {
		const off = scheduledNotifications.subscribe((v) => {
			scheduledList = (v ?? []).slice().sort((a, b) => a.fireAt - b.fireAt)
		})
		return () => off()
	})

	$effect(() => {
		const off = recentActivity.subscribe((v) => {
			activityList = (v ?? []).slice().sort((a, b) => b.ts - a.ts)
		})
		return () => off()
	})

	// --- Send action ---
	async function handleSend() {
		if (busy) return
		const recipient = recipients.find((u) => u.id === selectedRecipientId)
		if (!recipient) {
			outcome = { kind: 'error', detail: 'no recipient selected' }
			return
		}
		const trimmed = text.trim()
		if (!trimmed) return
		busy = true
		outcome = null
		try {
			const result = await sendNotification({
				recipientId: recipient.id,
				recipientName: recipient.name,
				text: trimmed,
				scheduleSec
			})
			if (result?.scheduled) {
				outcome = { kind: 'scheduled', detail: `fires in ${scheduleSec}s` }
				text = ''
			} else if (result?.ok) {
				outcome = { kind: result.ack === 'dismiss' ? 'dismissed' : 'delivered', detail: recipient.name }
				text = ''
			} else {
				outcome = { kind: result?.kind ?? 'error', detail: result?.error ?? 'unknown' }
			}
		} catch (err) {
			outcome = { kind: 'error', detail: err?.code ?? err?.message ?? String(err) }
		} finally {
			busy = false
		}
	}

	async function handleCancel(id) {
		try {
			await cancelScheduled(id)
		} catch (err) {
			outcome = { kind: 'error', detail: `cancel failed: ${err?.message ?? err}` }
		}
	}

	// --- Live "fires in Ns" countdown for scheduled entries ---
	let nowMs = $state(Date.now())
	let clockTimer = null
	onMount(() => {
		clockTimer = setInterval(() => { nowMs = Date.now() }, 250)
	})
	onDestroy(() => {
		if (clockTimer) clearInterval(clockTimer)
	})

	function secondsUntil(fireAt) {
		const ms = Math.max(0, fireAt - nowMs)
		return Math.ceil(ms / 1000)
	}

	function timeAgo(ts) {
		const sec = Math.max(0, Math.round((nowMs - ts) / 1000))
		if (sec < 5) return 'just now'
		if (sec < 60) return `${sec}s ago`
		const min = Math.floor(sec / 60)
		return `${min}m ago`
	}

	function activityLabel(kind) {
		switch (kind) {
			case 'delivered': return 'delivered'
			case 'dismissed': return 'dismissed'
			case 'scheduled': return 'scheduled'
			case 'fired':     return 'fired'
			case 'cancelled': return 'cancelled'
			case 'timeout':   return 'timed out'
			case 'offline':   return 'offline'
			case 'error':     return 'error'
			default:          return kind
		}
	}

	function activityClass(kind) {
		switch (kind) {
			case 'delivered': return 'badge-success'
			case 'dismissed': return 'badge-warning'
			case 'scheduled': return 'badge-info'
			case 'fired':     return 'badge-info'
			case 'cancelled': return 'badge-ghost'
			case 'timeout':   return 'badge-warning'
			case 'offline':   return 'badge-error'
			case 'error':     return 'badge-error'
			default:          return 'badge-ghost'
		}
	}

	function outcomeClass(kind) {
		switch (kind) {
			case 'delivered': return 'alert-success'
			case 'scheduled': return 'alert-info'
			case 'dismissed': return 'alert-warning'
			case 'offline':   return 'alert-error'
			case 'timeout':   return 'alert-warning'
			default:          return 'alert-error'
		}
	}
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Notifications: push, reply, schedule</h1>
		<p class="text-sm opacity-70 mt-1">
			Open this page in two browsers, pick the other user as recipient,
			send a message. Their tab pops a card; the value they click comes
			back as your <code>live.push</code> reply. Or schedule it 3 seconds
			out and watch the 6-field <code>live.cron</code> tick drain it.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Sending as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono" data-testid="my-id" data-user-id={me.id}>({me.id.slice(0, 8)})</span>
			</p>
		{/if}
	</header>

	<!-- Inbox: incoming cards -->
	<section class="card bg-base-100 border border-base-300" data-testid="inbox-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Incoming ({incoming.length})</h2>
			{#if incoming.length === 0}
				<p class="opacity-40 text-sm" data-testid="inbox-empty">
					Nothing yet. When someone pushes you a notification, the card appears here with reply buttons.
				</p>
			{:else}
				<ul class="space-y-2" data-testid="inbox-list">
					{#each incoming as card (card.id)}
						<li class="alert alert-info" data-testid="inbox-card">
							<div class="flex-1">
								<div class="text-xs opacity-70">
									<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={card.fromUserColor}></span>
									<strong data-testid="inbox-card-from">{card.fromUserName}</strong>
									<span class="opacity-60"> · {timeAgo(card.sentAt)}</span>
								</div>
								<div class="text-sm" data-testid="inbox-card-text">{card.text}</div>
							</div>
							<div class="flex gap-2">
								<button class="btn btn-sm btn-success" onclick={() => ackIncoming(card.id, 'ok')} data-testid="inbox-ack-ok">
									Got it
								</button>
								<button class="btn btn-sm btn-warning" onclick={() => ackIncoming(card.id, 'dismiss')} data-testid="inbox-ack-dismiss">
									Dismiss
								</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	<!-- Send form -->
	<section class="card bg-base-200">
		<div class="card-body py-3 space-y-3">
			<h2 class="card-title text-sm">Send a notification</h2>
			<div class="flex flex-wrap gap-2 items-end">
				<label class="form-control flex-1 min-w-[14rem]">
					<span class="label-text text-xs">Recipient</span>
					<select
						class="select select-bordered select-sm"
						bind:value={selectedRecipientId}
						disabled={recipients.length === 0}
						data-testid="recipient-select"
					>
						{#if recipients.length === 0}
							<option value="">No other users online</option>
						{:else}
							{#each recipients as user (user.id)}
								<option value={user.id} data-testid="recipient-option-{user.id}">{user.name}</option>
							{/each}
						{/if}
					</select>
				</label>
				<label class="form-control flex-1 min-w-[10rem]">
					<span class="label-text text-xs">Schedule ({scheduleSec}s)</span>
					<!-- Compact dress on fine pointers, 44px floor where taps land.
					     ~10px per stop is untappable; steppers give exact-second control on coarse pointers. -->
					<div class="flex items-center gap-2">
						<button
							type="button"
							class="btn btn-outline btn-sm hidden pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:min-w-11"
							aria-label="Decrease schedule by one second"
							disabled={scheduleSec <= 0}
							onclick={() => stepSchedule(-1)}
							data-testid="schedule-dec"
						>-</button>
						<input
							type="range"
							class="range range-sm flex-1 pointer-coarse:range-lg pointer-coarse:min-h-11"
							min="0" max="30" step="1"
							bind:value={scheduleSec}
							data-testid="schedule-input"
						/>
						<button
							type="button"
							class="btn btn-outline btn-sm hidden pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:min-w-11"
							aria-label="Increase schedule by one second"
							disabled={scheduleSec >= 30}
							onclick={() => stepSchedule(1)}
							data-testid="schedule-inc"
						>+</button>
					</div>
				</label>
			</div>
			<form onsubmit={(e) => { e.preventDefault(); handleSend() }} class="flex gap-2">
				<input
					class="input input-bordered input-sm flex-1 pointer-coarse:min-h-11"
					bind:value={text}
					placeholder="Your message..."
					maxlength="200"
					data-testid="text-input"
				/>
				<button
					type="submit"
					class="btn btn-sm btn-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11"
					disabled={busy || recipients.length === 0 || !text.trim()}
					data-testid="send-button"
				>
					{busy ? 'Sending...' : (scheduleSec > 0 ? `Schedule (${scheduleSec}s)` : 'Send')}
				</button>
			</form>
			{#if outcome}
				<div class="alert {outcomeClass(outcome.kind)} py-2" data-testid="outcome">
					<span class="text-sm">
						<strong data-testid="outcome-kind">{activityLabel(outcome.kind)}</strong>
						{#if outcome.detail} - {outcome.detail}{/if}
					</span>
				</div>
			{/if}
		</div>
	</section>

	<!-- Scheduled queue -->
	<section class="card bg-base-100 border border-base-300">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Scheduled ({scheduledList.length})</h2>
			{#if scheduledList.length === 0}
				<p class="opacity-40 text-sm" data-testid="scheduled-empty">
					Nothing pending. Set a schedule above to enqueue a notification.
				</p>
			{:else}
				<ul class="space-y-1 text-sm" data-testid="scheduled-list">
					{#each scheduledList as entry (entry.id)}
						<li class="flex items-center gap-2" data-testid="scheduled-item">
							<span class="badge badge-info badge-sm">in {secondsUntil(entry.fireAt)}s</span>
							<span class="opacity-70">{entry.fromUserName} &rarr; {entry.toUserName}:</span>
							<span class="flex-1 truncate">{entry.text}</span>
							<button
								class="btn btn-ghost btn-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11"
								onclick={() => handleCancel(entry.id)}
								data-testid="scheduled-cancel-{entry.id}"
							>
								Cancel
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	<!-- Activity log -->
	<section class="card bg-base-100 border border-base-300">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Recent activity ({activityList.length})</h2>
			{#if activityList.length === 0}
				<p class="opacity-40 text-sm">Nothing yet.</p>
			{:else}
				<ul class="space-y-1 text-xs font-mono" data-testid="activity-list">
					{#each activityList as evt (evt.id)}
						<li class="flex items-center gap-2" data-testid="activity-item">
							<span class="opacity-50 w-12">{timeAgo(evt.ts)}</span>
							<span class="badge badge-sm {activityClass(evt.kind)}" data-testid="activity-kind">{activityLabel(evt.kind)}</span>
							<span class="opacity-70 truncate flex-1">
								{evt.fromUserName} &rarr; {evt.toUserName}: {evt.text}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>sendNotification</code> calls
			<code>live.push(&#123; userId &#125;, 'demos:notification', &#123;...&#125;,
			&#123; timeoutMs: 8000 &#125;)</code>. The reply value (the recipient's
			button click) becomes the RPC return. NOT_FOUND means neither this
			instance's local push registry nor the cluster connection registry
			has an entry for that user; timeout means they were online but
			didn't reply within 8 seconds.
		</p>
		<p>
			Client: <code>onPush('demos:notification', handler)</code> registers
			one handler at mount. Each push opens an unresolved Promise; the
			user's Got it / Dismiss click resolves it with
			<code>&#123; ack &#125;</code> and the value travels back to the
			sender.
		</p>
		<p>
			Scheduler: a single <code>live.cron('* * * * * *', ...)</code> tick
			drains the in-memory queue every second (6-field cron
			schedule). Pushes inside the tick are fire-and-forget so a slow
			recipient can't block the next tick; per-push outcomes land in the
			activity stream when they resolve.
		</p>
	</aside>
</div>
