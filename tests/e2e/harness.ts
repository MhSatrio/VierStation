// Browser end-to-end harness: boots the real server (production build of the client) against the scripted upstream, drives Chromium.
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { boot } from '../helpers.ts';
import { installUpstream } from '../upstream.ts';

export const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

function chromePath(): string {
  const base = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  for (const v of ['chromium-1248', 'chromium-1234']) { const p = join(base, v, 'chrome-win64', 'chrome.exe'); if (existsSync(p)) return p; }
  throw new Error('No Playwright Chromium found. Run: npx playwright-core install chromium');
}

export async function start() {
  installUpstream();
  const srv = await boot();
  const browser: Browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const open = async (viewport = { width: 1440, height: 900 }) => {
    // DPR (optional, default 1) raises the screenshot resolution without changing the layout; the video captures use 1.5.
    const ctx: BrowserContext = await browser.newContext({ viewport, deviceScaleFactor: Number(process.env.DPR ?? 1) || 1 });
    const page: Page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
    return { ctx, page, errors };
  };
  return { srv, browser, open, close: async () => { await browser.close(); await srv.close(); } };
}

/** Local mode: there is no account to create – opening the app shows the workspace straight away. (Name kept for the existing suites.) */
export async function register(page: Page, base: string) {
  await page.goto(base + '/');
  // first run of a fresh data folder: the setup screen asks for the lab name and the terms; accept them once (the choice is stored on the server)
  const accept = page.getByRole('button', { name: 'Accept and continue' });
  if (await accept.waitFor({ timeout: 4000 }).then(() => true, () => false)) {
    await page.getByLabel('Lab name').fill('Test Lab');
    await page.getByRole('checkbox', { name: /I have read and accept/ }).check();
    await accept.click();
  }
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
  return 'local';
}
