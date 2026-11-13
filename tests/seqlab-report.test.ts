// The PDF report: generated from a full synthetic workflow, then opened with PyMuPDF to prove it is a valid PDF with the brand font embedded and the stored facts on its pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, newUser, waitJob } from './helpers.ts';
import { installLabUpstream, QUERY } from './lab-upstream.ts';
import { purgeCache } from '../server/integrations/http.ts';
import { config } from '../server/config.ts';
import { woffToSfnt } from '../server/report/pdf.ts';
import { readFileSync } from 'node:fs';

let close: () => Promise<void>;
let u: Awaited<ReturnType<typeof newUser>>;
before(async () => {
  const s = await boot(); close = s.close; u = await newUser(s.base);
  purgeCache(); installLabUpstream(); config.offline = false; config.blastMinWaitMs = 1; config.blastPollMs = 10;
});
after(async () => { config.offline = true; await close(); });

test('WOFF → TrueType conversion yields a valid sfnt (checked with fontTools)', () => {
  const sfnt = woffToSfnt(readFileSync(join(import.meta.dirname, '..', 'node_modules', '@fontsource', 'jost', 'files', 'jost-latin-400-normal.woff')));
  const f = join(mkdtempSync(join(tmpdir(), 'vs-font-')), 'jost.ttf'); writeFileSync(f, sfnt);
  const out = execFileSync('python', ['-c', `from fontTools.ttLib import TTFont; t=TTFont(r"${f}"); print(t["head"].unitsPerEm, len(t.getGlyphOrder()), t.getBestCmap()[65])`], { encoding: 'utf8' }).trim();
  assert.match(out, /^1000 \d+ A$/);
});

test('PDF report from a complete workflow: valid PDF, Jost embedded, every section present, numbers equal the stored data', async () => {
  const imp = await u.api.post('/api/lab/import', { projectId: u.projectId, text: `>isolate_report\n${QUERY.slice(0, 5)}NN${QUERY.slice(7, 200)}NNNN${QUERY.slice(204)}` });
  const id = imp.json.recordIds[0], L = (p = '') => `/api/lab/${id}${p}`;
  const run = async (path: string, body: any) => { const r = await u.api.post(L(path), body); assert.equal(r.status, 200, JSON.stringify(r.json)); const d = await waitJob(u.api, r.json.jobId, 60_000); assert.equal(d.job.status, 'completed', JSON.stringify(d.job.error)); };
  await u.api.post(L('/clean'), { op: 'trim_ambiguous_ends' });
  await run('/blast', { params: { db: 'core_nt', program: 'megablast', hitlist: 50 } });
  await run('/relatives', { params: { maxRelatives: 8, minCoverage: 80, minIdentity: 80 } });
  await run('/species', { names: 'Alphus septimus' });
  await run('/outgroups', { params: { max: 3 } });
  const og = (await u.api.get(L('/dataset'))).json.outgroupAssistant;
  await u.api.post(L('/dataset'), { action: 'add_candidates', opId: og.opId, ids: og.candidates.map((c: any) => c.id), role: 'outgroup' });
  await run('/align', { params: { method: 'iterative' } });
  await run('/tree', { params: { method: 'nj', distance: 'k2p', bootstrap: 50, rooting: 'outgroup' } });
  await u.api.post(L('/identification'), { taxon: 'Alphus primus', rank: 'species', taxId: 1001, confidence: 'moderate', notes: 'Report test' });

  const r = await u.api.getBuffer(L('/export/report'));
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type') ?? '', /application\/pdf/); assert.match(r.headers.get('content-disposition') ?? '', /sequence_report\.pdf/);
  const buf = r.buf;
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const f = join(mkdtempSync(join(tmpdir(), 'vs-pdf-')), 'report.pdf'); writeFileSync(f, buf);
  if (process.env.KEEP_REPORT) writeFileSync(process.env.KEEP_REPORT, buf);
  const info = JSON.parse(execFileSync('python', ['-c', `
import fitz, json
d = fitz.open(r"${f}")
text = "\\n".join(p.get_text() for p in d)
fonts = sorted({x[3] for p in d for x in p.get_fonts()})
print(json.dumps({"pages": len(d), "fonts": fonts, "text": text, "meta": d.metadata["title"]}))`], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, maxBuffer: 50_000_000 }));
  assert.ok(info.pages >= 5, `pages ${info.pages}`);
  assert.ok(info.fonts.some((x: string) => /Jost-Regular/.test(x)) && info.fonts.some((x: string) => /Jost-SemiBold/.test(x)), `fonts ${info.fonts}`);
  for (const s of ['Sequence identification report', 'Summary', 'Raw sequence and quality', 'Cleaning and read merging', 'NCBI similarity search', 'Reference sequences', 'Multiple sequence alignment', 'Phylogenetic tree', 'Final identification', 'Workflow history', 'Reproducibility and limits', 'Alphus primus', 'Alphus septimus', 'Species added by name', 'bootstrap', 'Page 1 of']) assert.ok(info.text.includes(s), `report contains "${s}"`);
  const blast = (await u.api.get(L('/hits'))).json; assert.ok(info.text.includes(blast.hits[0].accession));
  const ops = (await u.api.get(L('/ops'))).json.ops; assert.ok(info.text.includes(`${ops.length} operation(s) logged`));
  assert.match(info.text, /Report test/); assert.match(info.text, /VierStation/);
  // standalone tree image
  const svg = (await u.api.get(L('/export/tree-svg'))); assert.equal(svg.status, 200); assert.match(svg.text, /^<svg /); assert.ok((svg.text.match(/<text /g) ?? []).length >= 5);
});

test('PDF of a record that only has its import step: sections for missing steps say so instead of inventing content', async () => {
  const imp = await u.api.post('/api/lab/import', { projectId: u.projectId, text: '>bare\nACGTACGTTGCATGCATGCCGATCGATCGTAGCTAGCTAGCTGATCGATCGTAGCTAGCTAGCTAGCT' });
  const id = imp.json.recordIds[0];
  const buf = (await u.api.getBuffer(`/api/lab/${id}/export/report`)).buf;
  const f = join(mkdtempSync(join(tmpdir(), 'vs-pdf-')), 'bare.pdf'); writeFileSync(f, buf);
  const text = execFileSync('python', ['-c', `import fitz; print("\\n".join(p.get_text() for p in fitz.open(r"${f}")))`], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
  for (const s of ['BLAST has not been run', 'No reference dataset has been assembled', 'No alignment has been made', 'No tree has been built', 'No identification has been recorded']) assert.ok(text.includes(s), s);
});
