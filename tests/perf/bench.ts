// Performance benchmark: 100k-record tables through the real HTTP API. Prints medians and writes tests/perf/out/results.json.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, newUser, tableMeta, waitJob } from '../helpers.ts';

process.env.API_RATE_PER_MIN = '100000000'; // the benchmark is a deliberate burst
const N = Number(process.env.BENCH_N ?? 100_000);
const out: Record<string, unknown> = { records: N, node: process.version, cpus: cpus().length, cpuModel: cpus()[0]?.model };
const s = await boot();
const u = await newUser(s.base);
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
const r1 = (x: number) => Math.round(x * 10) / 10;
async function time(label: string, f: () => Promise<unknown>, runs = 7) {
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); await f(); ts.push(performance.now() - t0); }
  const r = { median_ms: r1(med(ts)), p95_ms: r1(p95(ts)), first_ms: r1(ts[0]) };
  out[label] = r; console.log(label.padEnd(50), JSON.stringify(r));
}

const t = await tableMeta(u.api, u.tables.protein);
const chem = await tableMeta(u.api, u.tables.chemical);
const organisms = ['Homo sapiens', 'Mus musculus', 'Escherichia coli', 'Saccharomyces cerevisiae', 'Arabidopsis thaliana', 'Danio rerio'];
const AA = 'ACDEFGHIKLMNPQRSTVWY';
let seed = 1; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const seq = (n: number) => Array.from({ length: n }, () => AA[Math.floor(rnd() * 20)]).join('');
const t0 = performance.now();
const BATCH = 2000;
for (let i = 0; i < N; i += BATCH) {
  const recs = Array.from({ length: Math.min(BATCH, N - i) }, (_, k) => ({
    [t.byKey('name')]: `Protein ${i + k} ${organisms[(i + k) % 6]} kinase ${['alpha', 'beta', 'gamma', 'delta'][(i + k) % 4]}`, [t.byKey('accession')]: `P${String(10000 + i + k).padStart(5, '0')}`,
    [t.byKey('sequence')]: seq(60 + ((i + k) % 200)), [t.byKey('length')]: 60 + ((i + k) % 200), [t.byKey('reviewed')]: (i + k) % 3 === 0, [t.byKey('status')]: ['To fetch', 'Processing', 'Review', 'Completed', 'Failed'][(i + k) % 5],
  }));
  const r = await u.api.post(`/api/tables/${u.tables.protein}/records`, { records: recs, createChoices: true });
  if (r.status !== 200) throw new Error(r.text);
}
out.bulk_insert_s = r1((performance.now() - t0) / 1000);
out.insert_rate_per_s = Math.round(N / ((performance.now() - t0) / 1000));
console.log(`inserted ${N} records in ${out.bulk_insert_s}s (${out.insert_rate_per_s}/s), RSS ${rss()} MB`);

// 4k protein->chemical links with evidence metadata
const chems = (await u.api.post(`/api/tables/${u.tables.chemical}/records`, { records: Array.from({ length: 2000 }, (_, i) => ({ [chem.byKey('name')]: `Compound ${i}`, [chem.byKey('inchikey')]: `AAAAAAAAAAAAAA-${String(i).padStart(10, 'B')}-N` })) })).json.records.map((r: any) => r.id);
const ids = (await u.api.post(`/api/tables/${u.tables.protein}/query`, { limit: 5000, fieldIds: [] })).json.records.map((r: any) => r.id);
const rel = t.byName('Chemicals');
const t1 = performance.now();
for (let i = 0; i < 4000; i++) { const r = await u.api.patch(`/api/records/${ids[i]}`, { fields: { [rel]: [chems[i % 2000], chems[(i * 7) % 2000]] } }); if (r.status !== 200) throw new Error(r.text); }
out.link_write_per_s = Math.round(4000 / ((performance.now() - t1) / 1000));
console.log(`link edits: ${out.link_write_per_s}/s`);

const q = u.tables.protein;
const f = (name: string, spec: object) => time(name, () => u.api.post(`/api/tables/${q}/query`, spec));
const status = t.fields.find((x: any) => x.key === 'status').options.choices.find((c: any) => c.name === 'Completed').id;
await f('grid first page (200 rows, no filter)', { limit: 200 });
await f('grid page 400 of 500 (offset 80k)', { limit: 200, offset: 80_000 });
await f('filter: status = Completed (20k hits)', { limit: 200, filter: { mode: 'and', items: [{ field: t.byKey('status'), op: 'is', value: status }] } });
await f('filter + sort: length > 200, sort by name', { limit: 200, filter: { mode: 'and', items: [{ field: t.byKey('length'), op: 'gt', value: 200 }] }, sorts: [{ field: t.byKey('name'), dir: 'asc' }] });
await f('sort by length desc (100k rows)', { limit: 200, sorts: [{ field: t.byKey('length'), dir: 'desc' }] });
await f('group by status, sorted by length', { limit: 200, groupBy: { field: t.byKey('status'), dir: 'asc' }, sorts: [{ field: t.byKey('length'), dir: 'desc' }] });
await f('full-text search "kinase beta" (FTS5)', { limit: 50, search: 'kinase beta' });
await f('filter on a LINK field (has chemicals)', { limit: 200, filter: { mode: 'and', items: [{ field: rel, op: 'isNotEmpty' }] } });
await time('global search (workspace FTS) "Protein 99"', () => u.api.get(`/api/workspaces/${u.wsId}/search?q=Protein%2099`));
await time('load one record (2 links + provenance)', () => u.api.get(`/api/records/${ids[10]}`));
await time('update one record (PATCH)', () => u.api.patch(`/api/records/${ids[11]}`, { fields: { [t.byKey('function')]: 'x' + Math.random() } }), 20);
await time('create one record (POST)', () => u.api.post(`/api/tables/${q}/records`, { fields: { [t.byKey('name')]: 'new' } }), 20);
await time('project dashboard (SQL aggregations)', () => u.api.get(`/api/projects/${u.projectId}/dashboard?fresh=1`), 5);
await time('export 100k rows to CSV (one request)', () => u.api.post(`/api/tables/${q}/export`, { format: 'csv' }), 1);

const an = async (type: string, params: object, recs: number) => {
  const t2 = performance.now();
  const r = await u.api.post('/api/analysis', { type, tableId: q, recordIds: ids.slice(0, recs), params });
  const j = await waitJob(u.api, r.json.jobId, 180_000);
  const ms = Math.round(performance.now() - t2);
  out[`analysis ${type} (${recs} records)`] = { ms, status: j.job.status };
  console.log(`analysis ${type} (${recs} records)`.padEnd(50), ms, 'ms', j.job.status, j.job.error ?? '');
};
await an('comparison', { method: 'kmer', k: 3 }, 40); await an('comparison', {}, 20); await an('phylogeny', {}, 20); await an('alignment', { mode: 'msa' }, 20); await an('pca', {}, 2000);

// the main thread must stay responsive while a heavy analysis runs in its worker thread
const heavy = await u.api.post('/api/analysis', { type: 'phylogeny', tableId: q, recordIds: ids.slice(0, 50), params: {} });
const lat: number[] = []; const stop = Date.now() + 4000;
while (Date.now() < stop) { const a = performance.now(); await u.api.get('/api/health'); lat.push(performance.now() - a); await new Promise((r) => setTimeout(r, 20)); }
out['health latency during a 50-sequence phylogeny'] = { median_ms: r1(med(lat)), p95_ms: r1(p95(lat)), samples: lat.length };
console.log('health latency during a 50-sequence phylogeny:', JSON.stringify(out['health latency during a 50-sequence phylogeny']));
await waitJob(u.api, heavy.json.jobId, 180_000);
out.rss_mb = rss(); out.db_mb = Math.round(statSync(join(process.env.VIERSTATION_DATA_DIR!, 'vierstation.db')).size / 1048576);
console.log(`RSS ${out.rss_mb} MB, database ${out.db_mb} MB`);
const dir = join(dirname(fileURLToPath(import.meta.url)), 'out'); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'results.json'), JSON.stringify(out, null, 2));
await s.close();
