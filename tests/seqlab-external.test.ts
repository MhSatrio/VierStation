// Tests the external-aligner ADAPTER (detect → run → parse → verify → log) with stand-in executables named like MAFFT/MUSCLE.
// The stand-ins are NOT those programs: they call VierStation's own aligner. This proves the plumbing, not the quality of any real tool.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot, newUser, waitJob } from './helpers.ts';
import { installLabUpstream, QUERY } from './lab-upstream.ts';
import { purgeCache } from '../server/integrations/http.ts';
import { config } from '../server/config.ts';
import { detectAligners, runExternal } from '../server/seqlab/external.ts';

const here = dirname(fileURLToPath(import.meta.url));
const bin = mkdtempSync(join(tmpdir(), 'vs-bin-'));
const root = pathToFileURL(join(here, '..')).href;
writeFileSync(join(bin, 'standin.mjs'), `
import { readFileSync } from 'node:fs';
import { runMsa, defaultMsa } from '${root}/server/seqlab/msa.ts';
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-version')) { console.error('v7.505 (stand-in for tests)'); process.exit(0); }
const mode = process.env.STANDIN_MODE ?? 'ok';
if (mode === 'crash') { console.error('stand-in: simulated failure\\nsecond line'); process.exit(2); }
const file = args.find((a) => a.endsWith('in.fa')) ?? args[args.length - 1];
const recs = readFileSync(file, 'utf8').split('>').filter(Boolean).map((b) => { const [h, ...s] = b.split('\\n'); return [h.trim(), s.join('').trim()]; });
const r = runMsa(recs.map((x) => x[0]), recs.map((x) => x[1]), defaultMsa());
const rows = mode === 'mutate' ? r.rows.map((x, i) => (i === 0 ? x.replace(/A/, 'C') : x)) : r.rows;
process.stdout.write(recs.map((x, i) => '>' + x[0] + '\\n' + rows[i] + '\\n').join(''));
`);
if (process.platform === 'win32') writeFileSync(join(bin, 'mafft.cmd'), `@echo off\r\nnode --disable-warning=ExperimentalWarning "%~dp0standin.mjs" %*\r\n`);
else { writeFileSync(join(bin, 'mafft'), `#!/bin/sh\nexec node --disable-warning=ExperimentalWarning "$(dirname "$0")/standin.mjs" "$@"\n`); chmodSync(join(bin, 'mafft'), 0o755); }
process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;

let base = '', close: () => Promise<void>; let u: Awaited<ReturnType<typeof newUser>>; let rid = '';
before(async () => { const s = await boot(); base = s.base; close = s.close; u = await newUser(base); purgeCache(); installLabUpstream(); config.offline = false; config.blastMinWaitMs = 1; config.blastPollMs = 10; });
after(async () => { config.offline = true; await close(); });
const lab = (p = '') => `/api/lab/${rid}${p}`;

test('detection finds only the programs on PATH, with their reported version', async () => {
  const list = await detectAligners(true);
  assert.deepEqual(list.map((a) => a.id), ['mafft']);
  assert.match(list[0].version, /stand-in/);
  const eng = (await u.api.get('/api/lab-meta/aligners')).json.engines;
  assert.deepEqual(eng.map((e: any) => e.id), ['builtin', 'mafft']);
});

test('runExternal maps ids back, verifies residues, and reports failures readably', async () => {
  const [mafft] = await detectAligners();
  const seqs = ['ACGTACGTTTGACCAGT', 'ACGTACGTGACCAGT', 'ACGTTTGACCAGT'];
  const ok = await runExternal(mafft, seqs);
  assert.equal(ok.rows.length, 3); ok.rows.forEach((r, i) => assert.equal(r.replace(/-/g, ''), seqs[i])); assert.match(ok.command, /^mafft --auto --quiet --thread \d in\.fasta > out\.fasta$/);
  process.env.STANDIN_MODE = 'crash';
  await assert.rejects(() => runExternal(mafft, seqs), /exited with code 2: stand-in: simulated failure/);
  process.env.STANDIN_MODE = 'mutate';
  await assert.rejects(() => runExternal(mafft, seqs), /changed the residues/);
  process.env.STANDIN_MODE = 'ok';
  const ac = new AbortController(); ac.abort();
  await assert.rejects(() => runExternal(mafft, seqs, { signal: ac.signal }), /Cancelled/);
});

test('lab alignment job can use the external engine: logged with tool + version + command, residues intact; missing engines fail clearly', async () => {
  const imp = await u.api.post('/api/lab/import', { projectId: u.projectId, text: `>ext_test\n${QUERY}` }); rid = imp.json.recordIds[0];
  let r = await u.api.post(lab('/blast'), { params: {} }); assert.equal((await waitJob(u.api, r.json.jobId, 60_000)).job.status, 'completed');
  r = await u.api.post(lab('/relatives'), { params: { maxRelatives: 5 } }); assert.equal((await waitJob(u.api, r.json.jobId, 60_000)).job.status, 'completed');
  r = await u.api.post(lab('/align'), { params: { engine: 'mafft' } }); const done = await waitJob(u.api, r.json.jobId, 60_000);
  assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const a = (await u.api.get(lab('/alignment'))).json;
  assert.match(a.method, /external/); assert.equal(a.op.tool, 'MAFFT (external program)');
  const members = new Map((await u.api.get(lab('/export/fasta?what=dataset'))).text.split('>').filter(Boolean).map((b: string) => { const [h, ...s] = b.split('\n'); return [h.trim(), s.join('')] as const; }));
  a.labels.forEach((l: string, i: number) => assert.equal(a.rows[i].replace(/-/g, ''), members.get(l)));
  const op = (await u.api.get(lab(`/ops/${a.op.id}`))).json.op; assert.match(op.toolVersion, /stand-in/); assert.match(op.result.command, /mafft --auto/);
  assert.ok(op.warnings.some((w: string) => /sum-of-pairs score is computed by VierStation/.test(w)));
  const sc = (await u.api.get(lab(`/export/script?scope=op&op=${a.op.id}`))).json; assert.match(sc.code, /Command used .*mafft --auto/);
  r = await u.api.post(lab('/align'), { params: { engine: 'muscle' } }); const bad = await waitJob(u.api, r.json.jobId, 30_000);
  assert.equal(bad.job.status, 'failed'); assert.match(bad.job.error, /muscle is not installed/);
  const last = (await u.api.get(lab('/ops?step=align'))).json.ops.pop(); assert.equal(last.status, 'failed'); assert.match(last.error, /not installed/);
  assert.equal((await u.api.post(lab('/align'), { params: { engine: 'nope' } })).status, 400);
});
