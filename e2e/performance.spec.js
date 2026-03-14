import { test, expect } from '@playwright/test';

test.describe('Performance', () => {
	test('home page loads within acceptable time', async ({ page }) => {
		const start = Date.now();
		const response = await page.goto('/', { waitUntil: 'networkidle' });
		const loadTime = Date.now() - start;

		console.log(`Home page load time: ${loadTime}ms`);
		expect(response.status()).toBe(200);
		expect(loadTime).toBeLessThan(5000);
	});

	test('home page Web Vitals and resource metrics', async ({ page }) => {
		// Collect performance entries
		await page.goto('/', { waitUntil: 'networkidle' });
		await page.waitForTimeout(1000);

		const metrics = await page.evaluate(() => {
			const nav = performance.getEntriesByType('navigation')[0];
			const paint = performance.getEntriesByType('paint');
			const resources = performance.getEntriesByType('resource');

			const fcp = paint.find((e) => e.name === 'first-contentful-paint');

			const totalTransfer = resources.reduce((sum, r) => sum + (r.transferSize || 0), 0);
			const jsResources = resources.filter((r) => r.initiatorType === 'script');
			const cssResources = resources.filter((r) => r.initiatorType === 'css' || r.name.endsWith('.css'));
			const jsSize = jsResources.reduce((sum, r) => sum + (r.transferSize || 0), 0);
			const cssSize = cssResources.reduce((sum, r) => sum + (r.transferSize || 0), 0);

			return {
				// Navigation timing
				dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
				tcp: Math.round(nav.connectEnd - nav.connectStart),
				ssl: Math.round(nav.connectEnd - nav.secureConnectionStart),
				ttfb: Math.round(nav.responseStart - nav.requestStart),
				download: Math.round(nav.responseEnd - nav.responseStart),
				domInteractive: Math.round(nav.domInteractive - nav.startTime),
				domComplete: Math.round(nav.domComplete - nav.startTime),
				loadEvent: Math.round(nav.loadEventEnd - nav.startTime),

				// Paint
				fcp: fcp ? Math.round(fcp.startTime) : null,

				// Resources
				totalRequests: resources.length,
				totalTransferKB: Math.round(totalTransfer / 1024),
				jsFiles: jsResources.length,
				jsTransferKB: Math.round(jsSize / 1024),
				cssFiles: cssResources.length,
				cssTransferKB: Math.round(cssSize / 1024),

				// Document size
				documentTransferKB: Math.round((nav.transferSize || 0) / 1024)
			};
		});

		console.log('\n=== HOME PAGE PERFORMANCE ===');
		console.log(`DNS lookup:        ${metrics.dns}ms`);
		console.log(`TCP connect:       ${metrics.tcp}ms`);
		console.log(`SSL handshake:     ${metrics.ssl}ms`);
		console.log(`TTFB:              ${metrics.ttfb}ms`);
		console.log(`Download:          ${metrics.download}ms`);
		console.log(`DOM Interactive:   ${metrics.domInteractive}ms`);
		console.log(`DOM Complete:      ${metrics.domComplete}ms`);
		console.log(`Load Event:        ${metrics.loadEvent}ms`);
		console.log(`FCP:               ${metrics.fcp}ms`);
		console.log('--- Resources ---');
		console.log(`Total requests:    ${metrics.totalRequests}`);
		console.log(`Total transfer:    ${metrics.totalTransferKB} KB`);
		console.log(`Document:          ${metrics.documentTransferKB} KB`);
		console.log(`JS files:          ${metrics.jsFiles} (${metrics.jsTransferKB} KB)`);
		console.log(`CSS files:         ${metrics.cssFiles} (${metrics.cssTransferKB} KB)`);

		// Assertions
		expect(metrics.ttfb).toBeLessThan(2000);
		expect(metrics.fcp).toBeLessThan(3000);
		expect(metrics.domComplete).toBeLessThan(5000);
	});

	test('board page performance', async ({ page }) => {
		// Create a board first
		await page.goto('/');
		const input = page.getByPlaceholder(/board/i).or(page.locator('input[type="text"]').first());
		await input.fill(`Perf Test ${Date.now()}`);
		const createBtn = page.getByRole('button', { name: /create/i }).or(page.locator('form button[type="submit"]'));
		await createBtn.click();
		await page.waitForURL(/\/board\//);
		const boardPath = new URL(page.url()).pathname;

		// Now measure a fresh navigation to the board
		const start = Date.now();
		await page.goto(boardPath, { waitUntil: 'networkidle' });
		const loadTime = Date.now() - start;

		const metrics = await page.evaluate(() => {
			const nav = performance.getEntriesByType('navigation')[0];
			const paint = performance.getEntriesByType('paint');
			const resources = performance.getEntriesByType('resource');
			const fcp = paint.find((e) => e.name === 'first-contentful-paint');

			const totalTransfer = resources.reduce((sum, r) => sum + (r.transferSize || 0), 0);
			const jsResources = resources.filter((r) => r.initiatorType === 'script');
			const jsSize = jsResources.reduce((sum, r) => sum + (r.transferSize || 0), 0);

			return {
				ttfb: Math.round(nav.responseStart - nav.requestStart),
				domInteractive: Math.round(nav.domInteractive - nav.startTime),
				domComplete: Math.round(nav.domComplete - nav.startTime),
				loadEvent: Math.round(nav.loadEventEnd - nav.startTime),
				fcp: fcp ? Math.round(fcp.startTime) : null,
				totalRequests: resources.length,
				totalTransferKB: Math.round(totalTransfer / 1024),
				jsFiles: jsResources.length,
				jsTransferKB: Math.round(jsSize / 1024)
			};
		});

		console.log('\n=== BOARD PAGE PERFORMANCE ===');
		console.log(`Total load time:   ${loadTime}ms`);
		console.log(`TTFB:              ${metrics.ttfb}ms`);
		console.log(`DOM Interactive:   ${metrics.domInteractive}ms`);
		console.log(`DOM Complete:      ${metrics.domComplete}ms`);
		console.log(`Load Event:        ${metrics.loadEvent}ms`);
		console.log(`FCP:               ${metrics.fcp}ms`);
		console.log(`Total requests:    ${metrics.totalRequests}`);
		console.log(`Total transfer:    ${metrics.totalTransferKB} KB`);
		console.log(`JS files:          ${metrics.jsFiles} (${metrics.jsTransferKB} KB)`);

		expect(metrics.ttfb).toBeLessThan(2000);
		expect(metrics.domComplete).toBeLessThan(5000);
	});

	test('WebSocket connection establishes quickly', async ({ page }) => {
		const wsPromise = page.waitForEvent('websocket', { timeout: 10_000 });
		await page.goto('/');
		const ws = await wsPromise;

		console.log(`\nWebSocket URL: ${ws.url()}`);
		expect(ws.url()).toBeTruthy();

		// Wait for the WS to be connected and frames to flow
		const framePromise = ws.waitForEvent('framesent', { timeout: 10_000 });
		await framePromise;
		console.log('WebSocket: frames are being sent');
	});

	test('Lighthouse-style CLS check (no layout shift)', async ({ page }) => {
		await page.goto('/', { waitUntil: 'networkidle' });
		await page.waitForTimeout(2000);

		const cls = await page.evaluate(() => {
			return new Promise((resolve) => {
				let clsValue = 0;
				const observer = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						if (!entry.hadRecentInput) {
							clsValue += entry.value;
						}
					}
				});
				observer.observe({ type: 'layout-shift', buffered: true });
				// Give it a moment then report
				setTimeout(() => {
					observer.disconnect();
					resolve(clsValue);
				}, 1000);
			});
		});

		console.log(`\nCumulative Layout Shift: ${cls.toFixed(4)}`);
		expect(cls).toBeLessThan(0.1); // Good CLS threshold
	});

	test('no console errors on page load', async ({ page }) => {
		const errors = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				errors.push(msg.text());
			}
		});
		page.on('pageerror', (err) => {
			errors.push(err.message);
		});

		await page.goto('/');
		await page.waitForTimeout(3000);

		if (errors.length > 0) {
			console.log('\nConsole errors found:');
			errors.forEach((e) => console.log(`  - ${e}`));
		} else {
			console.log('\nNo console errors detected');
		}

		expect(errors).toHaveLength(0);
	});

	test('no console errors on board page', async ({ page }) => {
		const errors = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				errors.push(msg.text());
			}
		});
		page.on('pageerror', (err) => {
			errors.push(err.message);
		});

		// Create a board
		await page.goto('/');
		const input = page.getByPlaceholder(/board/i).or(page.locator('input[type="text"]').first());
		await input.fill(`Error Check ${Date.now()}`);
		const createBtn = page.getByRole('button', { name: /create/i }).or(page.locator('form button[type="submit"]'));
		await createBtn.click();
		await page.waitForURL(/\/board\//);

		errors.length = 0; // Reset after navigation
		await page.waitForTimeout(3000);

		if (errors.length > 0) {
			console.log('\nBoard page console errors:');
			errors.forEach((e) => console.log(`  - ${e}`));
		} else {
			console.log('\nNo console errors on board page');
		}

		expect(errors).toHaveLength(0);
	});
});
