import { register, start } from './harness.ts';
const h = await start();
const { page, errors } = await h.open();
page.on('console', (m) => { if (!/GL Driver/.test(m.text())) console.log('[console]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 500), (e.stack ?? '').slice(0, 600)));
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });
try {
  await register(page, h.srv.base);
  await page.getByLabel('Accession or sequence').fill('NM_000546'); await page.getByRole('button', { name: 'Fetch from NCBI' }).click(); await page.waitForTimeout(2500);
  await page.goto(h.srv.base + '/kind/dna'); await page.waitForSelector('.r'); await page.locator('.r').first().hover(); await page.getByRole('button', { name: 'Open record' }).first().click();
  await page.getByRole('button', { name: /Run full pipeline/ }).click(); await page.getByText('Pipeline finished').waitFor({ timeout: 60000 });
  await page.goto(h.srv.base + '/kind/protein'); await page.waitForSelector('.r');
  await page.locator('.r').first().hover(); await page.getByRole('button', { name: 'Open record' }).first().click();
  await page.getByRole('button', { name: /Open 3D viewer/ }).click();
  await page.waitForTimeout(6000);
  console.log('BODY:', (await page.locator('body').innerText()).split(String.fromCharCode(10)).join(' | ').slice(0, 300));
  const txt = await page.locator('.rp').innerText({ timeout: 2000 }).catch(() => '(no panel)');
  console.log('PANEL TEXT:', txt.split('\n').join(' | ').slice(0, 1200));
  console.log('canvas count', await page.locator('.viewer canvas').count());
  console.log('errors', errors);
  await page.screenshot({ path: 'tests/e2e/out/dbg-viewer.png' });
} finally { await h.close(); }
