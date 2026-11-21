// Browser test of the GeoJSON exchange: import a GeoJSON file through the import dialog, then export the same table as GeoJSON.
// Real server, real Chromium.   node --disable-warning=ExperimentalWarning tests/e2e/geojson.ts   (build first: npm run build)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { start } from './harness.ts';
import { Api, tableMeta } from '../helpers.ts';

let h: Awaited<ReturnType<typeof start>>; let page: Page; let api: Api; let tableId = '';
before(async () => {
  h = await start(); const o = await h.open(); page = o.page; api = new Api(h.srv.base);
  const st = await api.get('/api/app/state'); const ws = st.json.workspaces[0].id;
  const proj = (await api.get(`/api/workspaces/${ws}/projects`)).json.projects[0].id;
  const tables = (await api.get(`/api/workspaces/${ws}/tables?project=${proj}`)).json.tables as { id: string; kind: string }[];
  tableId = tables[0].id;
  for (const [name, type] of [['Latitude', 'number'], ['Longitude', 'number']] as const) {
    const meta = await tableMeta(api, tableId);
    if (!meta.fields.some((f: any) => f.name === name)) assert.equal((await api.post(`/api/tables/${tableId}/fields`, { name, type, options: { precision: 6 } })).status, 200);
  }
});
after(async () => { await h.close(); });

const geojson = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [115.2625, -8.5069] }, properties: { Place: 'Ubud pond' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [103.8198, 1.3521] }, properties: { Place: 'Singapore canal' } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { Place: 'a line' } },
  ],
});

test('a GeoJSON file is read through the import dialog: points become rows, lines are skipped and reported', async () => {
  await page.goto(h.srv.base + `/t/${tableId}`);
  await page.getByRole('button', { name: /Import CSV \/ GeoJSON/ }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'sites.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(geojson) });
  await page.getByText(/2 point\(s\) read; 1 feature\(s\) skipped/).waitFor({ timeout: 10000 });
  // Latitude and Longitude match the table's fields by name; Place becomes a new text field
  await page.getByRole('button', { name: /Import 2 rows/ }).click();
  await page.getByText(/Imported 2 records/).waitFor({ timeout: 15000 });
  const meta = await tableMeta(api, tableId);
  const recs = (await api.post(`/api/tables/${tableId}/query`, { limit: 50 })).json.records as any[];
  const lat = meta.byName('Latitude'), lon = meta.byName('Longitude'), place = meta.byName('Place');
  const ubud = recs.find((r) => r.fields[place] === 'Ubud pond');
  assert.ok(ubud, 'the Ubud record was not imported');
  assert.equal(ubud.fields[lat], -8.5069); assert.equal(ubud.fields[lon], 115.2625);
});

test('the same table exports as GeoJSON from the Export menu', async () => {
  await page.goto(h.srv.base + `/t/${tableId}`);
  await page.getByRole('button', { name: /Export/ }).first().click();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: /GeoJSON for QGIS/ }).click()]);
  assert.match(dl.suggestedFilename(), /\.geojson$/);
  const doc = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  assert.equal(doc.type, 'FeatureCollection');
  const ubud = doc.features.find((f: any) => f.properties.Place === 'Ubud pond');
  assert.deepEqual(ubud.geometry.coordinates, [115.2625, -8.5069]);
});
