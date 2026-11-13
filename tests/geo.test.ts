// Sample locations: parsers, country knowledge, geocoding precision, saving BLAST hits into the DNA table with their GenBank collection place, and the map points.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, newUser, waitJob } from './helpers.ts';
import { installLabUpstream, calls, QUERY } from './lab-upstream.ts';
import { purgeCache } from '../server/integrations/http.ts';
import { config } from '../server/config.ts';
import { countryAt, countryPlace, findCountry, parseGeoLocName, parseLatLon } from '../server/geo/places.ts';
import { geocodeText, precisionFromRank } from '../server/geo/geocode.ts';
import { PRECISIONS } from '../shared/geo.ts';

test('coordinates: GenBank lat_lon, plain decimals, rejected nonsense', () => {
  assert.deepEqual(parseLatLon('8.5069 S 115.2625 E'), { lat: -8.5069, lon: 115.2625 });
  assert.deepEqual(parseLatLon('38.52 N 122.99 W'), { lat: 38.52, lon: -122.99 });
  assert.deepEqual(parseLatLon('-6.2, 106.8'), { lat: -6.2, lon: 106.8 });
  assert.equal(parseLatLon('95 N 10 E'), null); assert.equal(parseLatLon('Bali'), null); assert.equal(parseLatLon(''), null);
  assert.deepEqual(parseGeoLocName('Indonesia: Bali, Ubud'), { country: 'Indonesia', parts: ['Bali', 'Ubud'] });
  assert.deepEqual(parseGeoLocName('Japan'), { country: 'Japan', parts: [] });
});

test('countries: names, aliases and ISO codes resolve offline; a point finds its country', () => {
  for (const n of ['Indonesia', 'indonesia', 'ID', 'IDN']) assert.equal(findCountry(n)?.iso3, 'IDN', n);
  assert.equal(findCountry('USA')?.iso3, 'USA'); assert.equal(findCountry('Viet Nam')?.iso3, 'VNM'); assert.equal(findCountry('UK')?.iso3, 'GBR'); assert.equal(findCountry('Atlantis'), null);
  assert.equal(countryAt(106.8, -6.2)?.iso3, 'IDN', 'Jakarta'); assert.equal(countryAt(139.7, 35.7)?.iso3, 'JPN', 'Tokyo'); assert.equal(countryAt(-30, 0), null, 'open Atlantic');
  const p = countryPlace('Japan')!; assert.equal(p.precision, 'country'); assert.ok(p.lat > 30 && p.lat < 40 && p.lon > 130 && p.lon < 145);
});

test('precision classes follow what the place IS (Nominatim rank); the colour scale runs from dark navy to near-white', () => {
  assert.deepEqual([30, 26, 22, 18, 16, 12, 8, 4, 0].map(precisionFromRank), ['site', 'suburb', 'suburb', 'city', 'city', 'province', 'province', 'country', 'country']);
  const lum = (h: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const l = PRECISIONS.map((p) => lum(p.color)); for (let i = 1; i < l.length; i++) assert.ok(l[i] > l[i - 1], `${PRECISIONS[i].id} is lighter than ${PRECISIONS[i - 1].id}`);
  assert.equal(PRECISIONS.find((p) => p.id === 'city')!.color, '#4570B6', 'the VierApparatus blue sits in the middle of the scale');
});

let close: () => Promise<void>;
let u: Awaited<ReturnType<typeof newUser>>;
before(async () => {
  const s = await boot(); close = s.close; u = await newUser(s.base);
  purgeCache(); installLabUpstream(); config.offline = false; config.blastMinWaitMs = 1; config.blastPollMs = 10;
});
after(async () => { config.offline = true; await close(); });

test('geocoding: country-only needs no network; a full name is graded by what matched; missing parts fall back to a coarser (lighter) match', async () => {
  calls.length = 0;
  const c = await geocodeText('Japan'); assert.equal(c.place?.precision, 'country'); assert.equal(calls.filter((x) => x.url.includes('nominatim')).length, 0, 'no request for a bare country');
  const ubud = await geocodeText('Ubud, Bali, Indonesia'); assert.equal(ubud.place?.precision, 'suburb'); assert.ok(Math.abs(ubud.place!.lat + 8.5069) < 1e-3);
  const gb = await geocodeText('Indonesia: Bali, Ubud'); assert.equal(gb.place?.precision, 'suburb', 'GenBank order is understood');
  const coarse = await geocodeText('Nowhereville, Bali, Indonesia'); assert.equal(coarse.place?.precision, 'province'); assert.match(coarse.note ?? '', /not found as a whole/);
  const none = await geocodeText('Atlantis'); assert.equal(none.place, null);
  const gps = await geocodeText('8.5 S 115.2 E'); assert.equal(gps.place?.precision, 'exact');
});

test('save BLAST hits to the DNA table, with collection place from GenBank; the map shows them; unlocated names can be looked up; user coordinates are never overwritten', async () => {
  const imp = await u.api.post('/api/lab/import', { projectId: u.projectId, text: `>unknown_sample\n${QUERY}` });
  const id = imp.json.recordIds[0], L = (p = '') => `/api/lab/${id}${p}`;
  let r = await u.api.post(L('/blast'), { params: { db: 'core_nt', program: 'megablast', hitlist: 50 } });
  assert.equal((await waitJob(u.api, r.json.jobId, 60_000)).job.status, 'completed');
  // pick four hits: exact lat_lon, a Bali place name, a bare country, and a place that does not exist
  const acc = ['KX000001.1', 'KX000002.1', 'KX000003.1', 'KX000004.1'];
  r = await u.api.post(L('/hits/save'), { accessions: acc, region: 'aligned' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const done = await waitJob(u.api, r.json.jobId, 60_000); assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const op = (await u.api.get(L('/ops'))).json.ops.filter((o: any) => o.step === 'hits_saved').at(-1);
  const res = (await u.api.get(L(`/ops/${op.id}`))).json.op.result; assert.equal(res.created, 4);
  // they are real DNA records now
  const q1 = await u.api.post(`/api/tables/${res.tableId}/query`, {});
  const rows: any[] = q1.json.records ?? q1.json.rows ?? []; const flat = JSON.stringify(rows);
  for (const a of acc) assert.ok(flat.includes(a), `${a} is in the DNA table`);
  assert.match(flat, /BLAST hit of “unknown_sample”/); assert.match(flat, /Indonesia: Bali, Ubud/);
  // saving again does not duplicate
  r = await u.api.post(L('/hits/save'), { accessions: ['KX000001.1'], region: 'aligned' });
  assert.equal((await waitJob(u.api, r.json.jobId, 60_000)).job.status, 'completed');
  const again = (await u.api.get(L('/ops'))).json.ops.filter((o: any) => o.step === 'hits_saved').at(-1);
  assert.equal((await u.api.get(L(`/ops/${again.id}`))).json.op.result.existing, 1);

  // map points straight after saving: exact (lat_lon) and country (bare country centre); the others only have a NAME so far
  let g = (await u.api.get(`/api/geo/points?project=${u.projectId}`)).json;
  const byAcc = (a: string) => g.points.find((p: any) => p.accession === a);
  assert.equal(byAcc('KX000001.1').precision, 'exact'); assert.ok(Math.abs(byAcc('KX000001.1').lat + 8.5069) < 1e-3);
  assert.equal(byAcc('KX000003.1').precision, 'country'); assert.match(byAcc('KX000003.1').source, /country centre/);
  assert.equal(byAcc('KX000002.1'), undefined); assert.ok(g.unlocated.some((x: any) => /Ubud/.test(x.location)));
  assert.ok(g.unlocated.some((x: any) => /Atlantis/.test(x.location)));
  assert.equal(g.scale.length, 7);

  // look up the place names (one OpenStreetMap request each)
  const ids = g.unlocated.map((x: any) => x.id);
  r = await u.api.post('/api/geo/locate', { recordIds: ids });
  const lj = await waitJob(u.api, r.json.jobId, 60_000); assert.equal(lj.job.status, 'completed');
  g = (await u.api.get(`/api/geo/points?project=${u.projectId}`)).json;
  assert.equal(byAcc2(g, 'KX000002.1').precision, 'suburb'); assert.match(byAcc2(g, 'KX000002.1').source, /Nominatim/);
  assert.equal(g.points.find((p: any) => p.accession === 'KX000004.1'), undefined, 'a name nobody can find stays off the map instead of getting a made-up pin');
  assert.ok(g.unlocated.some((x: any) => /Atlantis/.test(x.location)));

  // a person sets exact coordinates; a later lookup must not overwrite them
  const rid = byAcc2(g, 'KX000002.1').recordId;
  assert.equal((await u.api.post('/api/geo/set', { recordId: rid, lat: -8.51, lon: 115.26, precision: 'site' })).status, 200);
  r = await u.api.post('/api/geo/locate', { recordIds: [rid] }); await waitJob(u.api, r.json.jobId, 60_000);
  const p2 = byAcc2((await u.api.get(`/api/geo/points?project=${u.projectId}`)).json, 'KX000002.1'); assert.equal(p2.precision, 'site'); assert.equal(p2.lat, -8.51); assert.equal(p2.source, 'entered by user');
  assert.equal((await u.api.post('/api/geo/set', { recordId: rid, lat: 123, lon: 0 })).status, 400);

  // the lab: where do the query's reference sequences come from?
  r = await u.api.post(L('/relatives'), { params: { maxRelatives: 6, minCoverage: 80, minIdentity: 80 } }); await waitJob(u.api, r.json.jobId, 60_000);
  r = await u.api.post(L('/geo/locate'), {}); const lg = await waitJob(u.api, r.json.jobId, 60_000); assert.equal(lg.job.status, 'completed', JSON.stringify(lg.job.error));
  const geo = (await u.api.get(L('/geo'))).json;
  assert.ok(geo.points.some((p: any) => p.accession === 'KX000001.1' && p.precision === 'exact'));
  assert.ok(geo.points.some((p: any) => p.accession === 'KX000003.1' && p.precision === 'country'));
  assert.ok(geo.unresolved.some((x: any) => /could not be located|states no collection place/.test(x.reason)), 'references without a usable place are listed, not guessed');
  // the world outline is served for the globe
  const w = await u.api.get('/api/geo/world'); assert.ok(w.json.countries.length > 150);
});
const byAcc2 = (g: any, a: string) => g.points.find((p: any) => p.accession === a);
