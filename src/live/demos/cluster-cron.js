/**
 * /demos/cluster-cron - Redis-backed leader election visualised end-to-end.
 *
 * The pitch: run two prod servers against the same Redis. Both register
 * the same 1Hz live.cron, but `live.configureCron({ leader })` (wired in
 * src/hooks.ws.js init) gates each tick on the cluster-wide lease. Only
 * the leader fires; the non-leader skips with a `cron{status:'not-leader'}`
 * metric increment. Stop the leader's process (Ctrl-C); the lease
 * expires within `renewMs` (10s); a sibling acquires it; the page
 * reflects the takeover with a fresh stream of ticks tagged with the
 * new leader's instanceId.
 *
 * Three primitives showcased:
 *
 *  - createLeader(redis, options?) - extensions . The Redis-
 *    lease primitive that elects exactly one worker across the cluster.
 *    `leader.isLeader()` is a microsecond-cost cached boolean check
 *    suitable for calling at the top of every cron tick. Wired once
 *    in src/lib/server/redis.js; this demo just consumes the export.
 *
 *  - live.configureCron({ leader }) - realtime wiring that gates every
 *    cron schedule in the app on the leader getter. Single-instance
 *    dev: this worker is always the leader so behaviour is identical
 *    to no-leader-config. Multi-worker: only the leader fires; a
 *    `leader_acquired_total{key_class}` counter on /metrics exposes
 *    transitions for ops dashboards.
 *
 *  - live.cron('* * * * * *', ...) - the cron registration itself.
 *    Identical shape to the firehose ticks in /demos/topk and
 *    /demos/news; the only thing that makes this one a cluster
 *    primitive is the leader gate around it.
 *
 * Storage is in-memory (demo only). Recent ticks are capped at TICK_CAP
 * with FIFO eviction; the FIFO drop publishes a 'deleted' event from
 * inside the same cron tick that pushed the new entry, so subscribers
 * never see the cap exceeded.
 */

import { live } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { leader } from '$lib/server/redis'

const TICK_CAP = 30

/** Newest at the END so the page can sort/render via slice/reverse. */
const recentTicks = []

let tickCount = 0

function appendTick(entry, ctx) {
	recentTicks.push(entry)
	while (recentTicks.length > TICK_CAP) {
		const dropped = recentTicks.shift()
		if (dropped) ctx.publish(TOPICS.demoClusterCronTick, 'deleted', { id: dropped.id })
	}
	ctx.publish(TOPICS.demoClusterCronTick, 'created', entry)
}

/**
 * Page-load probe. Returns this instance's identity, its current leader
 * status, and the in-memory recent-ticks snapshot. The page renders
 * without a flash of empty state on first mount even if zero ticks have
 * fired yet (e.g. a fresh boot with no Redis lease yet acquired).
 *
 * The clusterTicks stream is the source of truth thereafter; this RPC
 * just primes the panel.
 */
export const myClusterCronState = live(async () => ({
	instanceId: leader.instanceId,
	leaseKey: leader.key,
	isLeader: leader.isLeader(),
	tickCap: TICK_CAP,
	tickCount,
	ticks: recentTicks.slice()
}))

/**
 * Live stream of recent ticks. Capped at TICK_CAP with FIFO eviction
 * inside the cron tick (the eviction site is the only ctx-bearing path,
 * see appendTick).
 */
export const clusterTicks = live.stream(
	TOPICS.demoClusterCronTick,
	async () => recentTicks.slice(),
	{ merge: 'crud', key: 'id' }
)

/**
 * 1Hz tick. Gated by configureCron({ leader }) cluster-wide so only one
 * instance fires per second. Each fire publishes `{ id, instanceId, ts }`
 * onto the stream topic; the page renders the recent-tick log and uses
 * the latest entry's instanceId to highlight which worker is currently
 * the leader.
 *
 * Single-flight; cluster-singleton via configureCron({
 * leader }) wired in src/hooks.ws.js init.
 */
export const cronTick = live.cron('* * * * * *', TOPICS.demoClusterCronTick, async (ctx) => {
	tickCount += 1
	appendTick({
		id: crypto.randomUUID(),
		instanceId: leader.instanceId,
		ts: Date.now(),
		seq: tickCount
	}, ctx)
})
