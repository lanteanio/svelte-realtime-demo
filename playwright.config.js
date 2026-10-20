import { defineConfig } from '@playwright/test';
import { resolveE2EBaseURL } from './scripts/test-target.mjs';

// Targets and test secrets come from the caller, never from deployment files.
const BASE_URL = resolveE2EBaseURL();

// The suite splits into two projects:
//
// - `main`: workers=3, runs the default e2e set in parallel. Excludes
//   tests that are structurally incompatible with parallel workers
//   (the "alone on the page" tests assert no other presence entries
//   exist, which is false under workers>1 sharing one cluster), and
//   excludes the stress + destroyer specs which connect 1K+ bots and
//   would starve the cluster's quiet-cluster tests.
// - `isolated`: workers=1, runs only the parallel-incompatible specs.
//   No retries -- the stress / destroyer / alone tests want a clean
//   pass/fail signal under isolation, not a flaky-retry crutch.
//
// The local runner uses one worker and no retries. `test:e2e:all` runs both
// projects sequentially, resetting its databases between them. `test:e2e`
// runs main, and `test:e2e:isolated` runs isolated.
export default defineConfig({
	testDir: './e2e',
	timeout: 30_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	retries: 1,
	reporter: process.env.LOCAL_E2E === '1' ? 'list' : 'html',
	outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results',
	use: {
		baseURL: BASE_URL,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		video: 'on-first-retry'
	},
	projects: [
		{
			name: 'main',
			workers: 3,
			testIgnore: [
				'**/stress.spec.js',
				'**/destroyer.spec.js',
				'**/destroyer-presence.spec.js',
				'**/websocket-lifecycle.spec.js',
				'**/websocket-abrupt-close.spec.js'
			],
			grepInvert: /alone on the page/,
			use: { browserName: 'chromium' }
		},
		{
			name: 'isolated',
			workers: 1,
			retries: 0,
			timeout: 600_000,
			// The runner executes isolated even when main fails. Keep the two
			// projects sequential: load tests and quiet-cluster assertions
			// need exclusive use of the application instances.
			testMatch: [
				'**/stress.spec.js',
				'**/destroyer.spec.js',
				'**/destroyer-presence.spec.js',
				'**/demos-auctions.spec.js',
				'**/demos-notifications.spec.js',
				'**/websocket-lifecycle.spec.js',
				'**/websocket-abrupt-close.spec.js'
			],
			grep: /alone on the page|Stress Test|Destroyer Test|Presence Destroyer|WebSocket lifecycle|WebSocket abrupt close/,
			use: { browserName: 'chromium' }
		}
	]
});
