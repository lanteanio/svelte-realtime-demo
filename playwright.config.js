import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Auto-load .env from the project root into process.env so tests that
// depend on operational secrets (e.g. METRICS_SCRAPE_TOKEN for the
// /metrics endpoint in demos-cluster-cron.spec.js) work without the
// caller having to source the file manually. Existing process.env
// entries always win so an explicit override from the shell takes
// precedence over the file. Missing file is fine -- many environments
// won't have one (e.g. CI that injects env vars directly).
try {
	const env = readFileSync('.env', 'utf8');
	for (const line of env.split(/\r?\n/)) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
	}
} catch { /* no .env, that's fine */ }

const BASE_URL = process.env.BASE_URL || 'https://svelte-realtime-demo.lantean.io';

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
// `npm run test:e2e` runs both projects sequentially; `npm run
// test:e2e:fast` runs just `main` for quick iteration; `npm run
// test:e2e:isolated` runs just the isolated suite (which is where
// stress ceiling probes live and operators want focused output).
export default defineConfig({
	testDir: './e2e',
	timeout: 30_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	retries: 1,
	reporter: 'html',
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
				'**/destroyer-presence.spec.js'
			],
			grepInvert: /alone on the page/,
			use: { browserName: 'chromium' }
		},
		{
			name: 'isolated',
			workers: 1,
			retries: 0,
			timeout: 600_000,
			testMatch: [
				'**/stress.spec.js',
				'**/destroyer.spec.js',
				'**/destroyer-presence.spec.js',
				'**/demos-auctions.spec.js',
				'**/demos-notifications.spec.js'
			],
			grep: /alone on the page|Stress Test|Destroyer Test|Presence Destroyer/,
			use: { browserName: 'chromium' }
		}
	]
});
