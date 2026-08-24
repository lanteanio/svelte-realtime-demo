/**
 * Topic registry. Single source of truth for every topic the demo
 * publishes or subscribes to.
 *
 * The vite plugin scans for `live.stream(...)` and `live.channel(...)`
 * calls that take a literal string and validates the literal against
 * this registry. Mistyped topics fail loudly at build time instead of
 * silently producing a stream nobody subscribes to.
 *
 * Entries:
 * - boards         : list-level events (CRUD on the board collection)
 * - notes          : per-board note CRUD stream
 * - settings       : per-board settings stream
 * - activity       : per-board activity feed
 * - boardPresence  : per-board base topic for presence plugin
 *                    (the plugin prefixes with __presence: at the wire)
 *
 * Server-only. Client components use plain template strings; the
 * realtime build-time check covers server-side usage via live.stream
 * and the runtime topic-shape match catches client drift.
 */

import { defineTopics } from 'svelte-realtime/server'

export const TOPICS = defineTopics({
	boards: 'boards',
	notes: (boardId) => `board:${boardId}:notes`,
	settings: (boardId) => `board:${boardId}:settings`,
	activity: (boardId) => `board:${boardId}:activity`,
	boardPresence: (boardId) => `board:${boardId}`,
	demoCheckoutCount: 'demos:checkout:count',
	demoCounterTick: 'demos:counter:tick',
	demoChatRoom: (roomId) => `demos:chat:${roomId}`,
	demoTodos: 'demos:todos',
	demoAuditLog: (orgSlug) => `audit:${orgSlug}`,
	demoPressureTick: 'demos:pressure:tick',
	demoPressureShed: 'demos:pressure:shed',
	demoPressureNoise: 'demos:pressure:noise',
	demoChaosTick: (userId) => `demos:chaos:tick:${userId}`,
	demoNotificationsScheduled: 'demos:notifications:scheduled',
	demoNotificationsActivity: 'demos:notifications:activity',
	demoTopkEvent: 'demos:topk:event',
	demoTopkBase: 'demos:topk',
	// The firehose controls each carry a topic of their own so a change reaches
	// every open page. The values live in Redis, which the cron already reads,
	// so the simulation was shared before this existed; the topic is what makes
	// the READOUT shared, instead of a number each page sampled once on load.
	demoTopkControl: 'demos:topk:control',
	demoNewsStories: 'demos:news:stories',
	demoNewsView: 'demos:news:view',
	demoNewsControl: 'demos:news:control',
	demoNewsTopkBase: 'demos:news:topk',
	demoJobsList: 'demos:jobs:list',
	demoJobsStats: 'demos:jobs:stats',
	demoClusterCronTick: 'demos:cluster-cron:tick',
	demoUploadFiles: 'demos:upload:files',
	demoUploadStats: 'demos:upload:stats',
	demoAuctionsActive: 'demos:auctions:active',
	demoAuctionsRecent: 'demos:auctions:recent',
	demoSchemaCounter: 'demos:schema-evolution:counter',
	demoFlashProducts: 'demos:flash-sales:products',
	demoFlashSales: 'demos:flash-sales:sales',
	demoFlashCoupons: 'demos:flash-sales:coupons',
	demoPaginationLog: 'demos:pagination:log',
	demoEffectOrders: 'demos:effect:orders',
	demoEffectAudit: 'demos:effect:audit',
	demoEffectNotifications: 'demos:effect:notifications',
	demoFromSeqEvents: 'demos:fromseq:events',
	demoFromSeqFastEvents: 'demos:fromseq:events:fast',
	demoPurgeTick: 'demos:purge:tick',
	demoCollabDoc: 'demos:collab-editor:doc',
	demoCollabOffset: 'demos:collab-editor:offset',
	demoCollabCrdt: 'demos:collab-editor:crdt',
	demoMultiplayerLounge: 'demos:multiplayer:lounge',
	demoKanbanBoard: 'demos:kanban:board',
	demoOfflineEntries: 'demos:offline:entries',
	demoArenaMain: 'demos:arena:main',
	demoShooterRange: 'demos:shooter:range',
	demoLobbiesRoom: (id) => `demos:lobbies:${id}`,
	demoTenantsPad: 'demos:tenants:pad',
	demoFlagsBanner: 'demos:flags:banner',
	demoFlagsDarkLaunch: 'demos:flags:dark-launch',
	demoAlarmsLog: 'demos:alarms:log',
	demoAlarmsControl: 'demos:alarms:control',
	demoPrivacyMoods: 'demos:privacy:moods',
	demoPrivacyAggRaw: 'demos:privacy:agg-raw',
	demoPrivacyAggPrivate: 'demos:privacy:agg-private',
	demoOutboundOrders: 'demos:outbound:orders',
	demoPhasesFeed: 'demos:phases:feed'
})
