// Browser end-to-end test of the Sequence Lab (Chromium via playwright-core) against the production client build.
// NCBI is the synthetic scripted upstream from tests/lab-upstream.ts (known correct answer); the AB1 file is a real Sanger trace.
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { OUT, register, start } from './harness.ts';
import { installLabUpstream, lab, QUERY } from '../lab-upstream.ts';
import { config } from '../../server/config.ts';
import { reverseComplement } from '../../shared/sequence.ts';

const here = dirname(fileURLToPath(import.meta.url));
let h: Awaited<ReturnType<typeof start>>;
let page: Page; let errors: string[];
const test = (name: string, fn: () => Promise<void>) => nodeTest(name, async () => {
  try { await fn(); } catch (e) { await page?.screenshot({ path: join(OUT, `lab-fail-${name.slice(0, 24).replace(/\W+/g, '_')}.png`) }).catch(() => {}); throw e; }
});
before(async () => {
  h = await start(); installLabUpstream(); config.offline = false; config.blastMinWaitMs = 1; config.blastPollMs = 10;
  const o = await h.open({ width: 1440, height: 1000 }); page = o.page; errors = o.errors; await register(page, h.srv.base);
});
after(async () => { config.offline = true; await h.close(); });
const go = (p: string) => page.goto(h.srv.base + p);
const nav = (name: string) => page.locator('.lab-nav').getByRole('button', { name, exact: true }).click();

test('import a real AB1 file: lab opens with raw sequence, quality and a chromatogram', async () => {
  await go('/lab');
  await page.getByRole('heading', { name: 'Sequence Lab' }).waitFor();
  await page.getByRole('button', { name: /Import sequence/ }).first().click();
  await page.locator('input[type=file]').setInputFiles(join(here, '../fixtures/seqlab/3730.ab1'));
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('.lab-nav').waitFor({ timeout: 15000 });
  await page.getByRole('heading', { level: 2, name: 'Overview' }).waitFor();
  assert.match(await page.locator('.tiles').innerText(), /Raw length/);
  await nav('Quality inspection');
  await page.getByText('Phred quality along the read').waitFor();
  await page.locator('svg.chrom').waitFor();
  assert.ok((await page.locator('svg.chrom path').count()) >= 4, 'four dye traces drawn');
  await page.screenshot({ path: join(OUT, 'lab-quality.png') });
});

test('tooltips: hover delay, keyboard focus, Escape, touch-style click, accessible description', async () => {
  const tip = page.locator('[role=tooltip]');
  const gc = page.locator('.tile', { hasText: 'GC content' }).locator('button.helptip');
  await gc.hover();
  assert.equal(await tip.count(), 0, 'not shown immediately on hover');
  await tip.waitFor({ timeout: 2000 });
  assert.match(await tip.innerText(), /Percentage of G and C/);
  await page.screenshot({ path: join(OUT, 'lab-tooltip.png'), clip: { x: 440, y: 120, width: 820, height: 260 } });
  const id = await tip.getAttribute('id');
  assert.equal(await gc.getAttribute('aria-describedby'), id, 'trigger is described by the tooltip');
  await page.keyboard.press('Escape'); assert.equal(await tip.count(), 0);
  await page.mouse.move(5, 5);
  await gc.focus(); await tip.waitFor({ timeout: 300 }); // keyboard focus is immediate
  assert.match(await tip.innerText(), /GC|G and C/);
  await page.locator('body').click({ position: { x: 5, y: 5 } }); await gc.blur();
  await page.locator('.tile', { hasText: 'Ambiguous bases' }).locator('button.helptip').click(); // tap/click toggles
  await tip.waitFor(); assert.match(await tip.innerText(), /IUPAC/);
  await page.keyboard.press('Escape');
});

test('cleaning: trim creates a new version, undo/redo, raw vs clean comparison and change log', async () => {
  await nav('Cleaning');
  const lenText = () => page.locator('.lab-head .chip').first().innerText();
  const before = parseInt(await lenText(), 10);
  const card = page.locator('.opcard', { hasText: 'Trim low-quality ends (window)' });
  await card.getByRole('button', { name: 'Apply' }).click();
  await page.waitForFunction((b) => parseInt(document.querySelector('.lab-head .chip')!.textContent!, 10) < b, before);
  const after1 = parseInt(await lenText(), 10); assert.ok(after1 < before, `${before} → ${after1}`);
  await page.getByRole('button', { name: /Undo/ }).click();
  await page.waitForFunction((b) => parseInt(document.querySelector('.lab-head .chip')!.textContent!, 10) === b, before);
  await page.getByRole('button', { name: /Redo/ }).click();
  await page.waitForFunction((a) => parseInt(document.querySelector('.lab-head .chip')!.textContent!, 10) === a, after1);
  await page.getByRole('button', { name: /Raw vs cleaned/ }).click();
  await page.getByText(/amber = removed/).waitFor();
  assert.ok(await page.locator('.seqbox .nt-x').count() > 0, 'removed bases are highlighted');
  await page.getByText('Change log of cleaning steps').waitFor();
  assert.ok(await page.locator('.timeline-op').count() >= 1);
  await page.screenshot({ path: join(OUT, 'lab-cleaning.png') });
});

test('full identification workflow on a pasted sequence (BLAST → relatives → outgroups → alignment → tree → conclusion)', async () => {
  await go('/lab');
  await page.getByRole('button', { name: /Import sequence/ }).first().click();
  await page.getByPlaceholder(/isolate_17/).fill(`>isolate_17\n${QUERY}`);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('.lab-nav').waitFor({ timeout: 15000 });
  // BLAST
  await nav('NCBI matches');
  await page.getByRole('button', { name: 'Run BLAST' }).click();
  await page.locator('table.t tbody tr.hitrow').first().waitFor({ timeout: 40000 });
  assert.ok((await page.locator('tr.hitrow').count()) >= 5);
  await page.screenshot({ path: join(OUT, 'lab-matches.png') });
  await page.locator('tr.hitrow').first().click();
  await page.locator('.alnpair').waitFor();
  assert.match(await page.locator('.alnpair').innerText(), /Query[\s\S]*Sbjct/);
  await page.getByLabel('Hide uncultured / unresolved names').check().catch(async () => { await page.getByText('Hide uncultured / unresolved names').click(); });
  await page.getByText(/Showing \d+ of \d+/).waitFor();
  // relatives
  await nav('Related species');
  await page.getByRole('button', { name: 'Retrieve close relatives' }).click();
  await page.getByText('Alphus secundus').first().waitFor({ timeout: 40000 });
  await page.getByText(/candidate\(s\) were not used/).waitFor();
  await page.screenshot({ path: join(OUT, 'lab-relatives.png') });
  // outgroups
  await nav('Outgroups');
  await page.getByRole('button', { name: 'Find outgroup candidates' }).click();
  await page.getByText('Gammus primus').first().waitFor({ timeout: 60000 });
  await page.getByText(/Only 2 suitable/).waitFor();
  await page.locator('label.panel input[type=checkbox]').first().check();
  await page.locator('label.panel input[type=checkbox]').nth(1).check();
  await page.getByRole('button', { name: /Use 2 selected as outgroups/ }).click();
  await page.getByRole('heading', { name: /Outgroups in the dataset \(2\)/ }).waitFor();
  await page.screenshot({ path: join(OUT, 'lab-outgroups.png') });
  // alignment
  await nav('Alignment');
  await page.getByRole('button', { name: 'Run alignment' }).click();
  await page.locator('.alnblk').first().waitFor({ timeout: 30000 });
  assert.match(await page.locator('.row.wrap', { hasText: 'sequences' }).first().innerText(), /7 sequences/);
  await page.locator('.alnblk .c').nth(3).click();
  await page.getByRole('button', { name: 'Insert gap before' }).click();
  await page.getByText(/1 manual edit/).waitFor();
  // undo the experiment so the tree below is built from the correct alignment: select the new gap (first run of the first row) and delete it
  await page.locator('.alnblk .c').nth(0).click();
  await page.getByRole('button', { name: 'Delete this gap' }).click();
  await page.getByText(/2 manual edit/).waitFor();
  await page.locator('summary', { hasText: 'Pairwise alignment' }).click();
  await page.getByRole('button', { name: 'Align pair' }).click();
  await page.getByText(/% identity/).last().waitFor();
  assert.ok((await page.locator('.alnpair').count()) >= 1);
  await page.screenshot({ path: join(OUT, 'lab-alignment.png') });
  // tree
  await nav('Phylogenetic tree');
  await page.locator('label', { hasText: 'Bootstrap replicates' }).locator('input').fill('20');
  await page.getByRole('button', { name: 'Build tree' }).click();
  await page.locator('svg[aria-label="Phylogenetic tree"]').waitFor({ timeout: 60000 });
  await page.getByText(/Interpretation/).first().waitFor();
  assert.match(await page.locator('.treewrap').innerText(), /query/);
  assert.match(await page.locator('.panel', { hasText: 'Interpretation' }).first().innerText(), /Nearest sequences by tree distance: Alphus primus \(KX000001\.1\) – 0\.0/);
  const interp = await page.locator('.panel', { hasText: 'Interpretation' }).first().innerText();
  assert.match(interp, /Alphus/, interp);
  await page.getByText('What this cannot tell you').waitFor();
  await page.screenshot({ path: join(OUT, 'lab-tree.png') });
  // viewer: layouts, collapse, zoom, export
  for (const l of ['Cladogram', 'Circular', 'Rectangular (to scale)']) { await page.getByLabel('Tree layout', { exact: true }).selectOption({ label: l }); await page.locator('svg[aria-label="Phylogenetic tree"] text').first().waitFor(); }
  const tips0 = await page.locator('svg[aria-label="Phylogenetic tree"] text').count();
  await page.getByRole('button', { name: 'Collapse all' }).click();
  assert.ok((await page.locator('svg[aria-label="Phylogenetic tree"] text').count()) < tips0, 'collapsing folds clades');
  await page.getByRole('button', { name: 'Expand all' }).click();
  const g = page.locator('svg[aria-label="Phylogenetic tree"] g[data-zoom]');
  const t0 = await g.getAttribute('transform');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  assert.notEqual(await g.getAttribute('transform'), t0);
  const dl = page.waitForEvent('download'); await page.getByRole('button', { name: /SVG/ }).click();
  assert.match((await dl).suggestedFilename(), /\.svg$/);
  // final identification
  await nav('Final identification');
  await page.getByLabel('Taxon').fill('Alphus primus');
  await page.getByLabel(/Also link this sequence to the Organism record/).check();
  await page.getByRole('button', { name: 'Record conclusion' }).click();
  await page.getByText('Your recorded conclusion:').waitFor();
  await page.getByText(/linked to the Organism record as your conclusion/).waitFor();
  await page.screenshot({ path: join(OUT, 'lab-final.png') });
  // history + exports
  await nav('Workflow history');
  await page.locator('.timeline-op').first().waitFor();
  assert.ok((await page.locator('.timeline-op').count()) >= 8);
  await page.locator('.timeline-op > summary').first().click();
  await page.screenshot({ path: join(OUT, 'lab-history.png') });
  await nav('Exports');
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.locator('.modal pre').waitFor();
  const md = await page.locator('.modal pre').innerText();
  assert.match(md, /# Sequence workflow history – isolate_17/); assert.match(md, /Identification: Alphus primus/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /View & download/ }).click();
  await page.locator('.modal pre.code').waitFor();
  assert.match(await page.locator('.modal').innerText(), /Reproducibility: partial/);
  assert.match(await page.locator('.modal pre.code').innerText(), /NCBIWWW\.qblast/);
  assert.ok(!/api[_-]?key/i.test(await page.locator('.modal pre.code').innerText()));
  await page.keyboard.press('Escape');
  await page.screenshot({ path: join(OUT, 'lab-exports.png') });
});

test('existing DNA record opens in the lab through its record panel', async () => {
  await go('/kind/dna');
  await page.locator('.r').first().hover(); await page.getByRole('button', { name: 'Open record' }).first().click();
  await page.locator('.rp').waitFor();
  await page.getByRole('link', { name: /Open in Sequence Lab/ }).click();
  await page.locator('.lab-nav').waitFor();
});

test('mobile layout: lab navigation scrolls horizontally, page does not', async () => {
  const m = await h.open({ width: 390, height: 800 });
  await m.page.goto(h.srv.base + '/');
  await m.page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
  await m.page.goto(h.srv.base + '/lab');
  await m.page.getByRole('heading', { name: 'Sequence Lab' }).waitFor();
  assert.equal(await m.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await m.page.screenshot({ path: join(OUT, 'lab-mobile.png') });
  await m.ctx.close();
});

test('forward + reverse read merge, species typed by name, and the PDF report', async () => {
  const noisy = (seq: string, every: number, off: number) => seq.split('').map((c, i) => ((i + off) % every === 0 ? 'N' : c)).join('');
  await go('/lab');
  await page.getByRole('button', { name: /Import sequence/ }).first().click();
  await page.getByPlaceholder(/isolate_17/).fill(`>pair_F
${noisy(QUERY.slice(0, 420), 5, 0)}`);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('.lab-nav').waitFor({ timeout: 15000 });
  await nav('Cleaning');
  await page.getByRole('button', { name: 'Merge with a reverse read…' }).click();
  await page.getByRole('button', { name: 'Paste the reverse read' }).click();
  // an unrelated reverse read is refused with an explanation, nothing is created
  await page.getByRole('textbox', { name: 'Reverse read' }).fill(`>bad
${'ACGTTGCAAC'.repeat(8)}`);
  await page.getByRole('button', { name: 'Create merged sequence' }).click();
  await page.getByText(/do not overlap reliably/).first().waitFor({ timeout: 10000 });
  // the real reverse read (opposite strand, different N positions) becomes ONE new merged sequence
  await page.getByRole('textbox', { name: 'Reverse read' }).fill(`>pair_R
${reverseComplement(noisy(QUERY.slice(230), 5, 2))}`);
  await page.getByRole('button', { name: 'Create merged sequence' }).click();
  await page.locator('.lab-head h1', { hasText: /^Merged: pair_F \(\w{6}\) \+ pair_F_reverse/ }).waitFor({ timeout: 15000 });
  assert.match(await page.locator('.lab-head').innerText(), /700 bp|69\d bp/);
  await nav('Raw sequence');
  await page.getByText('This sequence is a merge.').waitFor();
  await page.screenshot({ path: join(OUT, 'lab-merge.png') });
  // the lab list shows ONE merged entry with its two source reads underneath
  await go('/lab');
  await page.locator('tr.hitrow', { hasText: /^Merged: pair_F/ }).first().waitFor();
  assert.equal(await page.locator('tr.subrow').count() >= 2, true, 'forward and reverse read are listed under the merged sequence');
  assert.equal(await page.locator('tr.hitrow:not(.subrow)', { hasText: /^pair_F( |$)/ }).count(), 0, 'the source reads are not listed as separate top-level sequences');
  await page.screenshot({ path: join(OUT, 'lab-list-merged.png') });
  await page.locator('tr.hitrow', { hasText: /^Merged: pair_F/ }).first().click();
  await page.locator('.lab-nav').waitFor();
  // species by name
  await nav('Related species');
  await page.getByLabel('Species names').fill('Alphus quintus');
  await page.getByRole('button', { name: /Collect 1 species/ }).click();
  await page.getByText(/Alphus quintus \(KZ000001\.1\)|KZ000001\.1/).first().waitFor({ timeout: 60000 });
  await page.getByText(/Last request/).waitFor();
  await page.screenshot({ path: join(OUT, 'lab-species.png') });
  // exports: PDF + tree svg links
  await nav('Exports');
  const href = await page.getByRole('link', { name: /Download PDF/ }).getAttribute('href');
  assert.match(href ?? '', /\/export\/report$/);
  const res = await page.request.get(h.srv.base + href!);
  assert.equal(res.status(), 200); assert.match(res.headers()['content-type'] ?? '', /application\/pdf/);
  assert.equal((await res.body()).subarray(0, 5).toString(), '%PDF-');
});

test('save BLAST hits to the DNA table, then see where they were collected on the globe', async () => {
  await go('/lab');
  await page.getByRole('button', { name: /Import sequence/ }).first().click();
  await page.getByPlaceholder(/isolate_17/).fill(`>geo_sample
${QUERY}`);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('.lab-nav').waitFor({ timeout: 15000 });
  await nav('NCBI matches');
  await page.getByRole('button', { name: 'Run BLAST' }).click();
  await page.locator('tr.hitrow').first().waitFor({ timeout: 40000 });
  await page.getByLabel('Select KX000001.1').check();
  await page.getByLabel('Select KX000003.1').check();
  await page.getByRole('button', { name: /Save to the DNA table/ }).click();
  await page.getByText(/Saved to your DNA table/).first().waitFor({ timeout: 40000 });
  await go('/kind/dna');
  await page.getByRole('heading', { name: 'DNA Sequences' }).waitFor();
  await page.getByRole('button', { name: /Show map/ }).click();
  await page.locator('canvas[role=img]').waitFor();
  await page.getByText('How precise is each pin?').waitFor();
  await page.getByText(/^2 pins$/).waitFor({ timeout: 15000 });
  const rows = await page.locator('table.t tbody tr.hitrow').allInnerTexts();
  assert.ok(rows.some((r) => /Exact \(GPS point\)/.test(r)) && rows.some((r) => /Country/.test(r)), rows.join(' | '));
  await page.screenshot({ path: join(OUT, 'lab-map.png') });
  // the lab's own map page (references) opens too
  await page.goBack(); await page.goBack().catch(() => {});
});

test('BLAST page: an N-rich read gets blastn + a warning; a search with no hits is explained and can be re-run more sensitively', async () => {
  const noisy = (seq: string, every: number) => seq.split('').map((c, i) => (i % every === 0 ? 'N' : c)).join('');
  await go('/lab');
  await page.getByRole('button', { name: /Import sequence/ }).first().click();
  await page.getByPlaceholder(/isolate_17/).fill(`>nrich
${noisy(QUERY.slice(0, 400), 4)}`);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('.lab-nav').waitFor({ timeout: 15000 });
  await nav('NCBI matches');
  await page.getByText('Hard-to-match sequence.').waitFor();
  assert.equal(await page.locator('label.field', { hasText: 'Program' }).locator('select').first().inputValue(), 'blastn');
  assert.match(await page.locator('.notice', { hasText: 'Searching:' }).first().innerText(), /nrich · version 1 · 400 bp/);
  // clean read, megablast, NCBI answers "no hits"
  await go('/lab');
  await page.getByRole('button', { name: /Import sequence/ }).first().click();
  await page.getByPlaceholder(/isolate_17/).fill(`>clean_one
${QUERY.slice(0, 300)}`);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('.lab-nav').waitFor({ timeout: 15000 });
  await nav('NCBI matches');
  assert.equal(await page.getByText('Hard-to-match sequence.').count(), 0);
  lab.noHits = true;
  await page.getByRole('button', { name: 'Run BLAST' }).click();
  await page.getByText('BLAST found no hits for this search.').waitFor({ timeout: 40000 });
  lab.noHits = false;
  await page.getByRole('button', { name: /Run blastn instead/ }).click();
  await page.locator('tr.hitrow').first().waitFor({ timeout: 40000 });
  assert.match(await page.locator('.row.small', { hasText: 'hit(s)' }).first().innerText(), /query “clean_one” v1, 300 bp/);
  await page.screenshot({ path: join(OUT, 'lab-blast-nohits-fixed.png') });
});

test('no uncaught page errors during the lab run', async () => { assert.deepEqual(errors, []); });
