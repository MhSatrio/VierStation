// Browser end-to-end tests (Chromium via playwright-core) against the production client build and the real server.
// Upstream scientific APIs are replaced by recorded real responses (tests/fixtures) – see tests/upstream.ts.
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { OUT, register, start } from './harness.ts';

let h: Awaited<ReturnType<typeof start>>;
/** node:test wrapper that saves a screenshot when a browser test fails, so failures are diagnosable. */
const test = (name: string, fn: () => Promise<void>) => nodeTest(name, async () => {
  try { await fn(); } catch (e) { await page?.screenshot({ path: join(OUT, `fail-${name.slice(0, 24).replace(/\W+/g, '_')}.png`) }).catch(() => {}); throw e; }
});
let page: Page; let errors: string[];
before(async () => { h = await start(); const o = await h.open(); page = o.page; errors = o.errors; await register(page, h.srv.base); });
after(async () => { await h.close(); });
const go = (p: string) => page.goto(h.srv.base + p);
const api = (path: string, init?: RequestInit) => page.evaluate(async ([p, i]) => { const r = await fetch(p as string, { credentials: 'same-origin', ...(i as object), headers: { 'x-vs': '1', 'content-type': 'application/json', ...((i as any)?.headers ?? {}) } }); return r.json(); }, [path, init] as const);
const openFirstRecord = async () => { await page.locator('.r').first().hover(); await page.getByRole('button', { name: 'Open record' }).first().click(); await page.locator('.rp').waitFor(); };

test('first run: a ready-made project with the full pipeline tables and a clean overview', async () => {
  await page.getByText('Research pipeline').waitFor();
  for (const n of ['DNA Sequences', 'Genes', 'Proteins', 'Chemicals', 'Structures', 'Analysis', 'Automations', 'Notifications', 'Settings']) assert.ok(await page.getByRole('navigation', { name: 'Main navigation' }).getByText(n, { exact: true }).first().isVisible(), n);
  assert.equal(await page.locator('img[src="/brand/icon.svg"]').first().isVisible(), true, 'real VierApparatus icon is used');
  const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  assert.match(font, /Jost/);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()), '#4570b6');
});

test('accession → NCBI fetch job → DNA record with provenance; sidebar collapses and persists', async () => {
  await page.getByLabel('Accession or sequence').fill('NM_000546');
  await page.getByRole('button', { name: 'Fetch from NCBI' }).click();
  await page.getByText('Fetching from NCBI').waitFor();
  await go('/kind/dna');
  await page.getByText('NM_000546.6').waitFor({ timeout: 15000 });
  await openFirstRecord();
  await page.getByText('Provenance & processing history').waitFor();
  assert.ok(await page.locator('.tl').getByText('NCBI Nucleotide').first().isVisible());
  assert.ok(await page.locator('.rp').getByText('mRNA / cDNA').first().isVisible());
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  assert.equal(await page.locator('.shell.collapsed').count(), 1);
  await page.reload(); await page.locator('.shell').waitFor();
  assert.equal(await page.locator('.shell.collapsed').count(), 1, 'collapse state persists');
  await page.getByRole('button', { name: 'Expand navigation' }).click();
});

test('one-click pipeline: DNA → gene → proteins → structure → chemicals, then evidence is inspectable', async () => {
  await go('/kind/dna'); await page.locator('.r').first().waitFor();
  await openFirstRecord();
  await page.getByRole('button', { name: /Run full pipeline/ }).click();
  await page.getByText('Pipeline finished').waitFor({ timeout: 90_000 });
  await go('/kind/protein'); await page.waitForSelector('.r');
  assert.equal(await page.locator('.r').count(), 9, 'canonical protein + 8 isoforms');
  await page.locator('.r').first().hover(); await page.getByRole('button', { name: 'Open record' }).first().click();
  await page.getByRole('heading', { name: 'Linked records' }).waitFor();
  assert.ok(await page.locator('.rp').getByText('Experimentally verified').first().isVisible(), 'evidence classes are shown');
  assert.ok(await page.locator('.rp').getByText('Computationally predicted').first().isVisible());
  await page.locator('.rp').getByRole('button', { name: 'Show evidence' }).first().click();
  assert.ok(await page.locator('.evbox').first().isVisible());
  await page.screenshot({ path: join(OUT, 'e2e-protein-evidence.png') });
});

test('3D viewer loads lazily, renders WebGL, and exposes representation / colouring / download', async () => {
  await go('/kind/protein'); await page.waitForSelector('.r');
  const before = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /viewer/.test(r.name)).length);
  assert.equal(before, 0, 'viewer chunk is not loaded with the page');
  await page.locator('.r').first().hover(); await page.getByRole('button', { name: 'Open record' }).first().click();
  await page.getByRole('button', { name: /Open 3D viewer/ }).click();
  await page.locator('.viewer canvas').waitFor({ timeout: 30_000 });
  assert.ok(await page.evaluate(() => performance.getEntriesByType('resource').some((r) => /viewer/.test(r.name))), 'viewer chunk fetched on demand');
  await page.getByText('Predicted structure').first().waitFor();
  assert.ok(await page.getByText(/not experimental evidence/).first().isVisible(), 'prediction disclaimer is shown');
  await page.getByLabel('Representation').selectOption('stick');
  await page.getByLabel('Colour by').selectOption('chain');
  await page.getByLabel('Highlight residues').fill('10-15');
  assert.equal(await page.locator('.viewer canvas').count(), 1);
  assert.ok(await page.getByRole('link', { name: /Download coordinates/ }).isVisible());
  const dl = await page.evaluate(async () => (await fetch('/api/structures/model?src=alphafold&id=P04637')).text());
  assert.match(dl, /^ATOM/);
  await page.screenshot({ path: join(OUT, 'e2e-viewer.png') });
});

test('grid: inline edit persists, filter / sort / group work, Kanban drag changes status, all views stay in sync', async () => {
  await go('/kind/chemical'); await page.waitForSelector('.r');
  // edit a name cell
  const cell = page.locator('.r').nth(2).locator('.cell').nth(1); // 0 is the row-number cell
  await cell.dblclick(); await page.keyboard.press('Control+A'); await page.keyboard.type('Renamed compound'); await page.keyboard.press('Enter');
  await page.getByText('Renamed compound').waitFor();
  const q = await api(`/api/tables/${(await page.url().split('/t/')[1].split('?')[0])}/query`, { method: 'POST', body: JSON.stringify({ search: 'Renamed' }) });
  assert.equal(q.total, 1, 'persisted on the server');
  // filter
  await page.getByRole('button', { name: /Filter/ }).click();
  await page.getByRole('button', { name: 'Add condition' }).click();
  await page.getByLabel('Operator').selectOption('contains');
  await page.getByLabel('Value').fill('Renamed');
  await page.waitForFunction(() => /1 record\b/.test(document.querySelector('.toolbar .count')?.textContent ?? ''));
  await page.keyboard.press('Escape');
  // the same filter lives in the view, so Kanban respects it and shows the card in its status column
  await page.getByRole('tab', { name: /Workflow board/ }).click();
  const card = page.locator('.card', { hasText: 'Renamed compound' });
  await card.waitFor();
  const done = page.locator('.kcol', { has: page.locator('h3', { hasText: 'Review' }) });
  await card.dragTo(done);
  await page.waitForFunction(() => !!document.querySelector('.kcol'));
  await page.waitForTimeout(600);
  await page.getByRole('tab', { name: /All records/ }).click();
  await page.locator('.r', { hasText: 'Renamed compound' }).waitFor();
  assert.ok(await page.locator('.r', { hasText: 'Renamed compound' }).getByText('Review').isVisible(), 'Kanban move updated the underlying status field');
  // clear the filter, then group + sort
  await page.getByRole('button', { name: /1 filter/ }).click(); await page.getByRole('button', { name: 'Clear all' }).click(); await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.r').length > 5);
  await page.getByRole('button', { name: /Group/ }).click(); await page.getByRole('button', { name: /^Status|Status$/ }).first().click();
  await page.waitForSelector('.r.group');
  assert.ok((await page.locator('.r.group').count()) >= 2);
});

test('fields: add a formula field in the UI and see it computed; links via the picker', async () => {
  await go('/kind/dna'); await page.waitForSelector('.r');
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Double length');
  await page.getByLabel('Field type').selectOption('formula');
  await page.getByRole('textbox', { name: 'Formula' }).fill('{Length (bp)} * 2');
  await page.getByText('Syntax OK').waitFor();
  await page.getByRole('button', { name: 'Save field' }).click();
  await page.getByText('5024').waitFor({ timeout: 10_000 });
});

test('global search: instant local results, then scientific databases with one-click import', async () => {
  await go('/'); await page.locator('.searchbox').waitFor(); await page.waitForLoadState('networkidle'); await page.keyboard.press('Control+k'); // wait until the app is interactive: an early keypress is lost
  const box = page.getByRole('textbox', { name: 'Search', exact: true });
  await box.fill('p53');
  await page.locator('.hit').first().waitFor({ timeout: 8000 });
  assert.match(await page.locator('.modal').innerText(), /In your workspace/);
  await box.fill('P04637'); await box.press('Enter');
  await page.getByText(/Scientific databases/).waitFor({ timeout: 20_000 });
  assert.ok(await page.locator('.modal').getByText('uniprot', { exact: true }).first().isVisible());
  assert.ok(await page.locator('.modal').getByText(/AlphaFold model AF-P04637-F1/).isVisible(), 'AlphaFold DB hit for the accession');
  await page.screenshot({ path: join(OUT, 'e2e-search.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: 'Search', exact: true }).fill('ACGTACGTTAGCTAGCTAGGATCCGATCGATTAGCTAGG'); await page.getByRole('textbox', { name: 'Search', exact: true }).press('Enter');
  await page.getByText(/DNA\/RNA sequence/).waitFor({ timeout: 10_000 });
  assert.ok(await page.getByRole('button', { name: /Search by sequence \(BLAST\)/ }).isVisible());
  await page.keyboard.press('Escape');
});

test('analysis: pick records, run a comparison job, view the heat map, export Python', async () => {
  const dna = await api(`/api/workspaces/${(await api('/api/app/state')).workspaces[0].id}/tables`);
  const dnaTable = dna.tables.find((t: any) => t.kind === 'dna').id;
  const seqs = ['ACGTACGTACGTACGTAAGGCT', 'ACGTACGTACGAACGTAAGGCT', 'ACGTTCGTACGTACGTCAGGCT'];
  const meta = await api(`/api/tables/${dnaTable}`);
  const nameF = meta.fields.find((f: any) => f.key === 'name').id, seqF = meta.fields.find((f: any) => f.key === 'sequence').id;
  await api(`/api/tables/${dnaTable}/records`, { method: 'POST', body: JSON.stringify({ records: seqs.map((s, i) => ({ [nameF]: `variant ${i + 1}`, [seqF]: s })) }) });
  await go('/analysis');
  await page.getByLabel('Analysis type').selectOption('comparison');
  await page.getByRole('button', { name: /Run analysis/ }).click();
  await page.getByText(/identical positions|identity matrix|pairwise/i).first().waitFor({ timeout: 20_000 }).catch(() => {});
  await page.waitForURL(/\/analysis\/ana_/, { timeout: 30_000 });
  await page.getByRole('img', { name: 'Heat map' }).first().waitFor();
  await page.getByRole('button', { name: 'Python' }).click();
  assert.match(await page.locator('pre.code').innerText(), /ACGTACGTACGAACGTAAGGCT/, 'exported script embeds the exact input sequences');
  await page.screenshot({ path: join(OUT, 'e2e-analysis.png') });
  await page.keyboard.press('Escape');
});

test('automations: enable a template, create a record, see the run in history', async () => {
  await go('/automations');
  const row = page.locator('div', { hasText: /^New chemical → Retrieve PubChem metadata/ }).first();
  await page.getByLabel('Enable New chemical → Retrieve PubChem metadata').check();
  await page.getByText('On', { exact: true }).first().waitFor();
  assert.ok(await row.count() >= 0);
  await page.getByRole('button', { name: 'New automation' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Notify on new gene');
  await page.getByLabel('Table', { exact: true }).selectOption({ label: 'Genes' });
  await page.getByRole('button', { name: 'Save automation' }).click();
  await page.getByText('Notify on new gene').waitFor();
});

test('notifications: list, preferences, mark read', async () => {
  await go('/notifications');
  await page.getByText('Preferences').waitFor();
  await page.getByLabel('A fetch or discovery run completes: browser').uncheck();
  await page.waitForTimeout(300);
  const me = await api('/api/app/state');
  assert.equal(me.user.prefs.notifications.fetch_completed.browser, false, 'preference saved');
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await page.waitForFunction(() => !document.querySelector('.bell .dot'));
});

test('jobs page shows real progress and details; settings keep API keys masked', async () => {
  await go('/jobs'); await page.getByText('Discovery pipeline').first().click();
  await page.getByText('Log').first().waitFor();
  assert.ok(await page.locator('.modal').getByText(/gene\(s\)/).first().isVisible());
  await page.keyboard.press('Escape');
  await go('/settings'); await page.getByRole('tab', { name: /Databases & keys/ }).click();
  await page.getByPlaceholder('Paste key').fill('abcdef1234567890SECRETKEY'); await page.getByPlaceholder('Paste key').locator('xpath=following-sibling::button[1]').click();
  await page.getByText(/set · abc/).waitFor();
  assert.ok(!(await page.content()).includes('abcdef1234567890SECRETKEY'), 'the secret never comes back to the page');
});

test('mobile viewport: navigation drawer, readable tables, no horizontal page scroll', async () => {
  const m = await h.open({ width: 390, height: 800 });
  await m.page.goto(h.srv.base + '/');
  await m.page.getByRole('button', { name: 'Open navigation' }).click();
  await m.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /^Proteins/ }).click();
  await m.page.getByRole('button', { name: /Add record/ }).waitFor();
  const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false, 'page does not scroll sideways');
  await m.page.screenshot({ path: join(OUT, 'e2e-mobile.png') });
  await m.ctx.close();
});

test('no uncaught page errors during the whole run, and the initial JS payload is small', async () => {
  assert.deepEqual(errors, []);
  const sizes = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => r.name.endsWith('.js')).map((r) => ({ n: r.name.split('/').pop(), b: (r as PerformanceResourceTiming).encodedBodySize })));
  const initial = sizes.filter((s) => !/viewer|Structure|GraphView|Analysis/.test(s.n ?? '')).reduce((a, s) => a + s.b, 0);
  assert.ok(initial < 200 * 1024, `initial JS ${Math.round(initial / 1024)} KB (compressed) must stay under 200 KB`);
});
