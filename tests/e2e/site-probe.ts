// Probe of the local VierApparatus website (read-only): prints the real links and headings of the pages the introduction shows.
// The analytics beacon is blocked so the probe never writes to the database.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.SITE ?? 'http://localhost:3001';
function chromePath(): string {
  const base = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  for (const v of ['chromium-1248', 'chromium-1234']) { const p = join(base, v, 'chrome-win64', 'chrome.exe'); if (existsSync(p)) return p; }
  throw new Error('no playwright chromium');
}
const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await ctx.route('**/api/collect', (r) => r.abort());
const page = await ctx.newPage();
const paths = process.argv.slice(2);
for (const p of paths) {
  const res = await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  const h1 = await page.locator('h1').allInnerTexts();
  const links = await page.$$eval('a[href]', (as) => [...new Set(as.map((a) => a.getAttribute('href') ?? ''))].filter((h) => h.startsWith('/') && !h.startsWith('//')).slice(0, 60));
  console.log(`\n== ${p} status=${res?.status()} h1=${JSON.stringify(h1.slice(0, 3))}`);
  console.log('   links:', links.join('  '));
}
await browser.close();
