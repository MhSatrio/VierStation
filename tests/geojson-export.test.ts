// GeoJSON export of a table with sample coordinates (for QGIS), through the real HTTP route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, newUser, tableMeta } from './helpers.ts';

let base = '', close: () => Promise<void>;
let u: Awaited<ReturnType<typeof newUser>>;
before(async () => { const s = await boot(); base = s.base; close = s.close; u = await newUser(base, 'Geo'); });
after(async () => { await close(); });

async function ensureField(tableId: string, name: string, type: string) {
  let meta = await tableMeta(u.api, tableId);
  if (!meta.fields.some((f: any) => f.name === name)) { const r = await u.api.post(`/api/tables/${tableId}/fields`, { name, type, ...(type === 'number' ? { options: { precision: 6 } } : {}) }); assert.equal(r.status, 200, r.text); meta = await tableMeta(u.api, tableId); }
  return meta;
}

test('GeoJSON export: points in [lon, lat] order with the other columns as properties; records without coordinates are left out and reported', async () => {
  const t = Object.values(u.tables)[0];
  await ensureField(t, 'Latitude', 'number'); await ensureField(t, 'Longitude', 'number'); await ensureField(t, 'Site', 'text');
  const meta = await tableMeta(u.api, t);
  const lat = meta.byName('Latitude'), lon = meta.byName('Longitude'), site = meta.byName('Site');
  const made = await u.api.post(`/api/tables/${t}/records`, { records: [
    { [lat]: -8.65, [lon]: 115.2, [site]: 'Ubud' },
    { [lat]: 1.35, [lon]: 103.8, [site]: 'Singapore' },
    { [site]: 'No coordinates yet' },
  ] });
  assert.equal(made.status, 200, made.text);

  const res = await u.api.post(`/api/tables/${t}/export`, { format: 'geojson' });
  assert.equal(res.status, 200, res.text);
  assert.match(res.headers.get('content-type') ?? '', /application\/geo\+json/);
  assert.match(res.headers.get('content-disposition') ?? '', /\.geojson"/);
  const doc = JSON.parse(res.text);
  assert.equal(doc.type, 'FeatureCollection');
  assert.equal(doc.features.length, 2);
  assert.equal(res.headers.get('x-skipped'), '1');
  const ubud = doc.features.find((f: any) => f.properties.Site === 'Ubud');
  assert.deepEqual(ubud.geometry, { type: 'Point', coordinates: [115.2, -8.65] });
  assert.ok(!('Latitude' in ubud.properties) && !('Longitude' in ubud.properties), 'the coordinates are the geometry, not repeated as properties');
});

test('GeoJSON export of a table with no Latitude/Longitude columns says so instead of writing an empty file', async () => {
  const other = await newUser(base, 'NoGeo');
  const t = Object.values(other.tables).find((id) => id !== undefined)!;
  const meta = await tableMeta(other.api, t);
  if (meta.fields.some((f: any) => /^(lat|latitude)$/i.test(f.name) || f.key === 'lat')) return;      // a starter table that already has coordinates: nothing to test here
  const res = await other.api.post(`/api/tables/${t}/export`, { format: 'geojson' });
  assert.equal(res.status, 400, res.text);
  assert.match(res.text, /no Latitude and Longitude/);
});
