// Cluster-relay reproducer for /demos/effect.
//
// Loads the demo N times in a clean context, clicks "Burst (5)", and
// checks whether the audit / notifications panels populated alongside
// the orders panel. Used to chase the live.effect cross-replica routing
// bugs in svelte-realtime 0.5.5 - 0.5.7 (missing relay, then double
// relay). Useful when investigating any future cross-replica routing
// suspicion: a non-zero "bad" count means the leader's reactive
// publishes are not reaching the user's worker exactly once.
//
// Usage (from repo root):
//   node scripts/debug-effect.mjs                                 # live URL
//   TARGET=http://localhost:5174/demos/effect node scripts/...    # local dev
//   RUNS=30 node scripts/debug-effect.mjs                         # more samples

import { chromium } from 'playwright'

const TARGET = process.env.TARGET ?? 'https://svelte-realtime-demo.lantean.io/demos/effect'
const RUNS = Number(process.env.RUNS ?? 15)

let bad = 0
for (let run = 1; run <= RUNS; run++) {
  const browser = await chromium.launch()
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  await page.goto(TARGET)
  await page.getByTestId('orders-empty').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
  await page.getByTestId('clear').click().catch(() => {})
  await page.waitForTimeout(800)

  await page.getByTestId('burst').click()
  await page.getByTestId('orders-row').first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
  await page.waitForTimeout(2500)

  const counts = await page.evaluate(() => ({
    orders: document.querySelectorAll('[data-testid=orders-row]').length,
    audit: document.querySelectorAll('[data-testid=audit-row]').length,
    notif: document.querySelectorAll('[data-testid=notifications-row]').length,
  }))

  const isBad = counts.audit !== counts.orders || counts.notif !== counts.orders
  if (isBad) bad++
  console.log(`run ${run}:`, counts, isBad ? '<<< BAD' : 'ok')
  await browser.close()
}
console.log(`\nTotal: ${bad}/${RUNS} bad`)
