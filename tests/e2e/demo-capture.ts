// Captures REAL screenshots of the real VierStation interface (1920x1080) for the Vier Apparatus introduction video.
// Every step is "before click" + "after click" + the bounding box of the thing that is clicked, so the video can animate a cursor
// over genuine interface states. Data = the scripted test upstream (synthetic taxa, a real Sanger AB1 trace): the video labels it "demonstration data".
// Run: node --disable-warning=ExperimentalWarning tests/e2e/demo-capture.ts   (writes into the introduction project's public/demo)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright-core';
import { register, start } from './harness.ts';
import { installLabUpstream, QUERY } from '../lab-upstream.ts';
import { config } from '../../server/config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DEMO = process.env.DEMO_OUT ?? 'C:/Users/satri/OneDrive/Dokumen/Claude Set/vier-platform-intro/public/demo';
mkdirSync(DEMO, { recursive: true });

const h = await start();
const steps: { id: string; label: string; bbox: { x: number; y: number; width: number; height: number } | null; a: string; b: string; kind: string }[] = [];
let page!: Page;
const nav = (name: string) => page.locator('.lab-nav').getByRole('button', { name, exact: true });
const snap = async (name: string) => { await page.screenshot({ path: join(DEMO, name) }); return name; };

/** One recorded interaction: screenshot, geometry of the target, perform it, wait until the interface settled, screenshot again. */
async function act(id: string, label: string, kind: 'click' | 'type' | 'view', target: Locator | null, doIt: () => Promise<void>, settle?: () => Promise<void>) {
  if (target) await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const bb = target ? await target.boundingBox() : null;
  const a = await snap(`${id}_a.png`);
  await doIt();
  if (settle) await settle();
  await page.waitForTimeout(700);
  const b = await snap(`${id}_b.png`);
  steps.push({ id, label, kind, bbox: bb, a, b });
  console.log('captured', id);
}

try {
  const o = await h.open({ width: 1920, height: 1080 });
  page = o.page;
  await register(page, h.srv.base);

  // 1. The workspace: fetch a record from NCBI, then the DNA table (scripted upstream)
  await act('fetch', 'Fetch a record from NCBI by accession', 'type', page.getByLabel('Accession or sequence'),
    async () => { await page.getByLabel('Accession or sequence').fill('NM_000546'); });
  await act('fetch_go', 'Click Fetch from NCBI', 'click', page.getByRole('button', { name: 'Fetch from NCBI' }),
    async () => { await page.getByRole('button', { name: 'Fetch from NCBI' }).click(); await page.waitForTimeout(2500); });
  await page.goto(h.srv.base + '/kind/dna'); await page.waitForSelector('[role=grid]'); await page.waitForTimeout(600);
  await act('dna_table', 'The DNA table: a record opens in a side panel', 'click', page.locator('.r').first(),
    async () => { await page.locator('.r').first().hover(); await page.getByRole('button', { name: 'Open record' }).first().click(); await page.waitForTimeout(1200); });

  // 2. The Sequence Lab with a real Sanger trace
  config.offline = false; config.blastMinWaitMs = 1; config.blastPollMs = 10;
  installLabUpstream();
  await page.goto(h.srv.base + '/lab'); await page.getByRole('heading', { name: 'Sequence Lab' }).waitFor();
  await act('lab_open', 'Open the Sequence Lab and choose Import sequence', 'click', page.getByRole('button', { name: /Import sequence/ }).first(),
    async () => { await page.getByRole('button', { name: /Import sequence/ }).first().click(); await page.waitForTimeout(500); });
  await act('lab_file', 'Choose a Sanger trace file (.ab1)', 'click', page.getByRole('button', { name: 'choose files' }),
    async () => { await page.locator('input[type=file]').setInputFiles(join(here, '../fixtures/seqlab/3730.ab1')); await page.waitForTimeout(400); });
  await act('lab_import', 'Import', 'click', page.getByRole('button', { name: 'Import', exact: true }),
    async () => { await page.getByRole('button', { name: 'Import', exact: true }).click(); await page.locator('.lab-nav').waitFor({ timeout: 15000 }); });
  await act('lab_quality', 'Quality inspection with the real chromatogram', 'click', nav('Quality inspection'),
    async () => { await nav('Quality inspection').click(); await page.locator('svg.chrom').waitFor(); });
  await act('lab_clean', 'Cleaning: trim low-quality ends', 'click', nav('Cleaning'),
    async () => { await nav('Cleaning').click(); await page.waitForTimeout(500); });
  const card = page.locator('.opcard', { hasText: 'Trim low-quality ends (window)' });
  await act('lab_trim', 'Apply the trim; the change is logged and can be undone', 'click', card.getByRole('button', { name: 'Apply' }),
    async () => { await card.getByRole('button', { name: 'Apply' }).click(); await page.waitForTimeout(900); });

  // 3. A pasted sequence through BLAST, relatives, alignment and tree (scripted NCBI with a known answer)
  await page.goto(h.srv.base + '/lab');
  await page.getByRole('button', { name: /Import sequence/ }).first().click();
  await page.getByPlaceholder(/isolate_17/).fill(`>isolate_17\n${QUERY}`);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('.lab-nav').waitFor({ timeout: 15000 });
  await act('blast_nav', 'Open NCBI matches', 'click', nav('NCBI matches'), async () => { await nav('NCBI matches').click(); await page.waitForTimeout(400); });
  await act('blast_run', 'Run BLAST: hits with identity and coverage', 'click', page.getByRole('button', { name: 'Run BLAST' }),
    async () => { await page.getByRole('button', { name: 'Run BLAST' }).click(); await page.locator('table.t tbody tr.hitrow').first().waitFor({ timeout: 40000 }); });
  await act('blast_row', 'Click a hit to see the real alignment', 'click', page.locator('tr.hitrow').first(),
    async () => { await page.locator('tr.hitrow').first().click(); await page.locator('.alnpair').waitFor(); });
  await nav('Related species').click();
  await act('rel_run', 'Retrieve close relatives', 'click', page.getByRole('button', { name: 'Retrieve close relatives' }),
    async () => { await page.getByRole('button', { name: 'Retrieve close relatives' }).click(); await page.getByText('Alphus secundus').first().waitFor({ timeout: 40000 }); });
  await nav('Outgroups').click();
  await page.getByRole('button', { name: 'Find outgroup candidates' }).click();
  await page.getByText('Gammus primus').first().waitFor({ timeout: 60000 });
  await page.locator('label.panel input[type=checkbox]').first().check();
  await page.locator('label.panel input[type=checkbox]').nth(1).check();
  await page.getByRole('button', { name: /Use 2 selected as outgroups/ }).click();
  await page.getByRole('heading', { name: /Outgroups in the dataset \(2\)/ }).waitFor();
  await nav('Alignment').click();
  await act('aln_run', 'Run the alignment: identical columns are marked', 'click', page.getByRole('button', { name: 'Run alignment' }),
    async () => { await page.getByRole('button', { name: 'Run alignment' }).click(); await page.locator('.alnblk').first().waitFor({ timeout: 30000 }); });
  await nav('Phylogenetic tree').click();
  await page.locator('label', { hasText: 'Bootstrap replicates' }).locator('input').fill('20');
  await act('tree_run', 'Build the phylogenetic tree', 'click', page.getByRole('button', { name: 'Build tree' }),
    async () => { await page.getByRole('button', { name: 'Build tree' }).click(); await page.locator('svg[aria-label="Phylogenetic tree"]').waitFor({ timeout: 60000 }); await page.getByText(/Interpretation/).first().waitFor(); });
  await nav('Exports').click();
  await page.waitForTimeout(800);
  await act('exports', 'Exports: PDF report, Python script, change log', 'view', page.getByText('Download PDF', { exact: true }).first(),
    async () => { await page.waitForTimeout(300); });
  writeFileSync(join(DEMO, 'manifest.json'), JSON.stringify({ viewport: { width: 1920, height: 1080 }, steps }, null, 1));
  console.log('errors:', o.errors);
} finally { config.offline = true; await h.close(); }
