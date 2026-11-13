// Exploratory run: register, run the full pipeline through the UI, visit each main screen and save screenshots for visual review.
import { join } from 'node:path';
import { OUT, register, start } from './harness.ts';

const h = await start();
const { page, errors } = await h.open();
const shot = (n: string) => page.screenshot({ path: join(OUT, n) });
try {
  await register(page, h.srv.base);
  await page.getByLabel('Accession or sequence').fill('NM_000546');
  await page.getByRole('button', { name: 'Fetch from NCBI' }).click();
  await page.waitForTimeout(2500);
  await page.goto(h.srv.base + '/kind/dna');
  await page.waitForSelector('[role=grid]');
  await page.locator('.r').first().hover();
  await page.getByRole('button', { name: 'Open record' }).first().click();
  await page.getByRole('button', { name: /Run full pipeline/ }).click();
  await page.waitForTimeout(9000);
  await shot('03-record-panel.png');
  await page.goto(h.srv.base + '/kind/protein'); await page.waitForSelector('[role=grid]'); await page.waitForTimeout(800); await shot('04-proteins.png');
  await page.locator('.r').first().hover(); await page.getByRole('button', { name: 'Open record' }).first().click(); await page.waitForTimeout(1500); await shot('05-protein-panel.png');
  await page.goto(h.srv.base + '/kind/chemical'); await page.waitForSelector('[role=grid]'); await page.waitForTimeout(800); await shot('06-chemicals.png');
  await page.getByRole('tab', { name: /Gallery/ }).click(); await page.waitForTimeout(800); await shot('07-chem-gallery.png');
  await page.getByRole('tab', { name: /Relationships/ }).click(); await page.waitForTimeout(6000); await shot('08-graph.png');
  await page.goto(h.srv.base + '/kind/gene'); await page.getByRole('tab', { name: /Workflow board/ }).click(); await page.waitForTimeout(1000); await shot('09-kanban.png');
  await page.goto(h.srv.base + '/jobs'); await page.waitForTimeout(800); await shot('10-jobs.png');
  await page.goto(h.srv.base + '/automations'); await page.waitForTimeout(800); await shot('11-automations.png');
  await page.goto(h.srv.base + '/analysis'); await page.waitForTimeout(800); await shot('12-analysis.png');
  await page.goto(h.srv.base + '/notifications'); await page.waitForTimeout(800); await shot('13-notifications.png');
  await page.goto(h.srv.base + '/databases'); await page.waitForTimeout(800); await shot('14-databases.png');
  console.log('errors:', errors);
} finally { await h.close(); }
