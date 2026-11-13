// Captures the REAL VierApparatus website (local `next dev`, read-only) for the platform introduction.
// Every step: screenshot before, perform the action (a click on a real link, or a view), wait for the page, screenshot after,
// and record the bounding box of the element the cursor points at. Nothing is submitted; the analytics beacon is blocked.
// Output: vier-platform-intro/public/site/*.png + public/site/manifest.json
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Locator, Page } from 'playwright-core';

const BASE = process.env.SITE ?? 'http://localhost:3001';
const OUT = process.env.SITE_OUT ?? 'C:/Users/satri/OneDrive/Dokumen/Claude Set/vier-platform-intro/public/site';
const VIEW = { width: 1920, height: 1080 };

function chromePath(): string {
  const base = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  for (const v of ['chromium-1248', 'chromium-1234']) { const p = join(base, v, 'chrome-win64', 'chrome.exe'); if (existsSync(p)) return p; }
  throw new Error('no playwright chromium');
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1.5, reducedMotion: 'reduce' });
await ctx.route('**/api/collect', (r) => r.abort());
// The newsletter card opens after a delay; the site remembers a dismissal in this browser's local storage (30 days). Set it here, in the capture browser only.
await ctx.addInitScript(() => { try { localStorage.setItem('vier.newsletter.dismissed', String(Date.now())); } catch { /* ignore */ } });
const page: Page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));

type Step = { id: string; label: string; kind: 'click' | 'view'; bbox: { x: number; y: number; width: number; height: number } | null; a: string; b: string; url: string };
const steps: Step[] = [];
const snap = async (name: string) => { await page.screenshot({ path: join(OUT, name) }); return name; };
const boxOf = async (loc: Locator | null) => (loc ? loc.first().boundingBox().catch(() => null) : null);

/** The newsletter sign-up dialog opens on some pages after a short delay: close it so it does not cover the content. */
async function closeNewsletter() {
  const dialog = page.getByRole('dialog', { name: /newsletter/i });
  if (await dialog.isVisible().catch(() => false)) {
    await page.locator('button[aria-label="Close"]').first().click().catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }
}
async function settle() {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(900);
  await closeNewsletter();
  await page.waitForTimeout(1500);
  await closeNewsletter();
}

/** A page visit without a click (the cursor rests on `target`). */
async function view(id: string, label: string, path: string, target: Locator | null, scrollTo?: Locator) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await settle();
  if (scrollTo) { await scrollTo.first().scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(500); }
  const bb = await boxOf(target);
  const b = await snap(`${id}.png`);
  steps.push({ id, label, kind: 'view', bbox: bb, a: b, b, url: path });
  console.log('view', id, path, bb ? 'target found' : 'no target');
}

/** A click on a real link: before = current page, after = the page it opens. */
async function click(id: string, label: string, target: Locator, expectPath?: string) {
  await target.first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  const bb = await boxOf(target);
  const a = await snap(`${id}_a.png`);
  const href = await target.first().getAttribute('href');
  await Promise.all([
    page.waitForURL((u) => (expectPath ? u.pathname.startsWith(expectPath) : true), { timeout: 60000 }).catch(() => {}),
    target.first().click(),
  ]);
  await settle();
  const b = await snap(`${id}_b.png`);
  steps.push({ id, label, kind: 'click', bbox: bb, a, b, url: new URL(page.url()).pathname });
  console.log('click', id, href, '->', new URL(page.url()).pathname);
}

try {
  // ---- modules: subjects, Biology, General Biology, a level, a module
  await view('mod_grid', 'Module subjects', '/module', page.locator('a[href="/module/chem"]:visible'));
  await click('mod_bio', 'Open Biology', page.locator('a[href="/module/bio"]:visible').first(), '/module/bio');
  await click('mod_gb', 'Open General Biology', page.locator('a[href="/module/bio/general-biology"]:visible').first(), '/module/bio/general-biology');
  await click('mod_level', 'Open Level 01', page.locator('main a[href="/module/bio/general-biology/foundations"]:visible').first(), '/module/bio/general-biology/foundations');
  await click('mod_page', 'Open a module', page.locator('main a[href="/module/bio/general-biology/foundations/introduction-to-biology/definition-of-biology"]:visible').first(), '/module/bio/general-biology/foundations/introduction-to-biology/definition-of-biology');

  // ---- other subjects are still being built: the subject page says so
  await view('mod_chem', 'Chemistry: curriculum in preparation', '/module/chem', page.getByText(/curriculum in preparation/i));

  // ---- articles (news, research updates, explainers)
  await view('news_articles', 'Articles', '/articles', page.locator('main a[href^="/articles/"]'));

  // ---- products: reviewed equipment, manufacturer information kept apart from reader comments
  // pick a product whose page has no test comment (checked on the product pages, nothing is written)
  await page.goto(BASE + '/products', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await settle();
  const slugs = (await page.$$eval('a[href^="/products/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href') ?? ''))])).filter((h) => /^\/products\/[^/]+$/.test(h));
  let chosen = '';
  for (const s of slugs.slice(0, 25)) {
    await page.goto(BASE + s, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(400);
    const txt = await page.locator('body').innerText();
    if (!/automated browser test/i.test(txt) && /Submit comment for review/.test(txt)) { chosen = s; break; }
  }
  if (!chosen) throw new Error('no product page without a test comment found');
  await view('prod_list', 'Product reviews list', '/products', page.getByRole('heading', { level: 1 }));
  await click('prod_open', 'Open a product', page.locator(`a[href="${chosen}"]:visible`).first(), chosen);
  await view('prod_score', 'Rating shown only with enough readers', chosen, page.getByText(/Not enough reader ratings/i), page.getByText(/Not enough reader ratings/i));
  await view('prod_form', 'Comment form with a human-check question', chosen, page.getByText(/Human check/i).first(), page.getByText(/Human check/i).first());

  // ---- how to contribute: an article proposal, and product information from manufacturers
  await view('contrib_page', 'Join as contributor', '/contribute', page.locator('ol').first(), page.locator('ol').first());
  await view('contact_product', 'Send product information', '/contact?type=Product%20submission', page.getByText(/Product submission/i).first());

  // ---- software: the real section and its download button (the cursor rests on the button; nothing is clicked)
  const dl = page.locator('a', { hasText: /Download VierStation/i }).first();
  await view('sw_section', 'VierStation section', '/software', page.locator('#vierstation'), page.locator('#vierstation'));
  await view('sw_download', 'Download button of VierStation', '/software', dl, dl);

  // ---- home (opening)
  await view('home', 'Home', '/', page.locator('h1').first());

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ viewport: VIEW, chosenProduct: chosen, steps }, null, 1));
  console.log('steps', steps.length, 'files', readdirSync(OUT).length, 'page errors', errors.length);
} finally {
  await browser.close();
}
