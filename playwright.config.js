import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolveE2EBaseURL } from './scripts/test-target.mjs';

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

const BASE_URL = resolveE2EBaseURL(process.env);

// The suite splits into two projects:
//
// - `main`: workers=1, runs the default e2e set serially. Excludes
//   tests that are structurally incompatible with parallel workers
//   (the "alone on the page" tests assert no other presence entries
//   exist, which is false under workers>1 sharing one cluster), and
//   excludes the stress + destroyer specs which connect 1K+ bots and
//   would starve the cluster's quiet-cluster tests.
// - `isolated`: workers=1, runs only the tests that assert they are alone.
// - resilience/cluster/stress/destroyer/diagnostics: opt-in projects exposed
//   by the local tier runner. They are not registered during a default
//   `playwright test`, which keeps expensive and assertion-free probes out
//   of the everyday pass count.
//
// `npm run test:e2e:safe` provisions dependencies and runs both core
// projects sequentially. Optional tiers have dedicated commands.
/** @type {import('@playwright/test').Project[]} */
const projects = [
	{
		name: 'main',
		workers: 1,
		retries: 0,
		testIgnore: [
			'**/_*.spec.js',
			'**/*.cluster.spec.js',
			'**/cluster-probe.spec.js',
			'**/cluster-bugs-probe.spec.js',
			'**/resilience.spec.js',
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
		testMatch: [
			'**/demos-auctions.spec.js',
			'**/demos-notifications.spec.js'
		],
		grep: /alone on the page/,
		use: { browserName: 'chromium' }
	}
];

const optionalProject = process.env.E2E_OPTIONAL_PROJECT;
if (optionalProject === 'resilience') {
	projects.push({
		name: 'resilience',
		workers: 1,
		retries: 0,
		timeout: 240_000,
		testMatch: ['**/resilience.spec.js'],
		use: { browserName: 'chromium' }
	});
} else if (optionalProject === 'cluster') {
	projects.push({
		name: 'cluster',
		workers: 1,
		retries: 0,
		testMatch: [
			'**/*.cluster.spec.js',
			'**/cluster-probe.spec.js',
			'**/cluster-bugs-probe.spec.js'
		],
		use: { browserName: 'chromium' }
	});
} else if (optionalProject === 'stress') {
	projects.push({
		name: 'stress',
		workers: 1,
		retries: 0,
		timeout: 600_000,
		testMatch: ['**/stress.spec.js'],
		use: { browserName: 'chromium' }
	});
} else if (optionalProject === 'destroyer') {
	projects.push({
		name: 'destroyer',
		workers: 1,
		retries: 0,
		timeout: 600_000,
		testMatch: ['**/destroyer.spec.js', '**/destroyer-presence.spec.js'],
		use: { browserName: 'chromium' }
	});
} else if (optionalProject === 'diagnostics') {
	projects.push({
		name: 'diagnostics',
		workers: 1,
		retries: 0,
		timeout: 120_000,
		testMatch: ['**/_*.spec.js'],
		use: { browserName: 'chromium' }
	});
}

export default defineConfig({
	testDir: './test/e2e',
	timeout: 30_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	retries: 0,
	// HTML report writes under the watched project root and can make Vite's
	// dev server reload the page during a local test. The provisioned harness
	// uses the streaming line reporter; ad-hoc interactive runs keep HTML.
	reporter: process.env.CI || process.env.LOCAL_E2E === '1'
		? 'line'
		: [['html', { open: 'never' }]],
	use: {
		baseURL: BASE_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure'
	},
	projects
});
