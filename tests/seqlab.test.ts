import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, newUser, waitJob } from './helpers.ts';
import { installLabUpstream, calls, QUERY, SUBJECTS, OUTGROUPS } from './lab-upstream.ts';
import { purgeCache } from '../server/integrations/http.ts';
import { config } from '../server/config.ts';
import { parseAb1, buildAb1 } from '../server/seqlab/formats.ts';

let base = '', close: () => Promise<void>;
let u: Awaited<ReturnType<typeof newUser>>;
let dbm: typeof import('../server/db.ts');
const here = dirname(fileURLToPath(import.meta.url));
before(async () => {
  const s = await boot(); base = s.base; close = s.close;
  dbm = await import('../server/db.ts');
  u = await newUser(base);
  purgeCache(); installLabUpstream(); config.offline = false; config.blastMinWaitMs = 1; config.blastPollMs = 10;
});
after(async () => { config.offline = true; await close(); });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let rid = '';
const lab = (p = '') => `/api/lab/${rid}${p}`;

function fastq(seq: string, qual: number[], id = 'read1') { return `@${id}\n${seq}\n+\n${qual.map((q) => String.fromCharCode(q + 33)).join('')}\n`; }
const NOISY_5 = 'NNNNACGTA', NOISY_3 = 'TTNNNNNN';

test('import: FASTQ read keeps raw sequence + qualities as an immutable raw version', async () => {
  const seq = NOISY_5 + QUERY + NOISY_3;
  const qual = [...Array(NOISY_5.length).fill(4), ...Array(QUERY.length).fill(36), ...Array(NOISY_3.length).fill(3)];
  const r = await u.api.post('/api/lab/import', { projectId: u.projectId, text: fastq(seq, qual, 'isolate_17'), marker: 'ITS', sampleId: 'S-17' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.imported, 1); rid = r.json.recordIds[0];
  const ov = (await u.api.get(lab())).json;
  assert.equal(ov.raw.length, seq.length); assert.equal(ov.head.length, seq.length); assert.ok(ov.raw.hasQuality);
  // the record's Sequence field mirrors the working version
  const insp = (await u.api.get(lab('/inspect'))).json;
  assert.equal(insp.hasQuality, true); assert.ok(insp.suggestions.some((s: any) => s.op === 'trim_window'), 'low-quality ends are suggested, not applied');
  assert.equal((await u.api.get(lab())).json.head.length, seq.length, 'inspection must not modify anything');
});

test('raw version is immutable at the database level', () => {
  const { q } = dbm;
  const raw = q.get<{ id: string }>("SELECT id FROM seq_versions WHERE record_id=? AND kind='raw'", rid)!;
  assert.throws(() => q.run('UPDATE seq_versions SET seq=? WHERE id=?', 'AAAA', raw.id), /immutable|raw/i);
  assert.throws(() => q.run('DELETE FROM seq_versions WHERE id=?', raw.id), /immutable|raw|cannot/i);
});

test('cleaning creates versions, logs changes, supports undo/redo/revert, and never touches raw', async () => {
  const before = (await u.api.get(lab())).json;
  const t = await u.api.post(lab('/clean'), { op: 'trim_window', threshold: 20, window: 10, ends: 'both' });
  assert.equal(t.status, 200, t.text); assert.match(t.json.summary, /removed/);
  let ov = (await u.api.get(lab())).json;
  assert.ok(ov.head.length < before.head.length && ov.head.length >= QUERY.length - 4, `trimmed to ${ov.head.length}`);
  assert.equal(ov.raw.length, before.raw.length, 'raw is untouched');
  const e = await u.api.post(lab('/clean'), { op: 'edit_base', pos: 10, base: 'R' });
  assert.equal(e.status, 200); ov = (await u.api.get(lab())).json; assert.equal(ov.head.seq[9], 'R');
  assert.equal((await u.api.post(lab('/clean'), { op: 'edit_base', pos: 10, base: 'Z' })).status, 400, 'invalid IUPAC code rejected');
  await u.api.post(lab('/undo')); ov = (await u.api.get(lab())).json; assert.notEqual(ov.head.seq[9], 'R'); assert.ok(ov.canRedo);
  await u.api.post(lab('/redo')); assert.equal((await u.api.get(lab())).json.head.seq[9], 'R');
  const cmp = (await u.api.get(lab('/compare'))).json;
  assert.ok(cmp.diff.available && cmp.diff.editCount === 1 && cmp.diff.removedCount > 0, JSON.stringify(cmp.diff).slice(0, 200));
  // fix the ambiguity again by reverting to the version before the edit → NEW version
  const versions = (await u.api.get(lab('/versions'))).json.versions;
  const trimmed = versions.find((v: any) => v.label?.startsWith('Trim low-quality'));
  const nBefore = versions.length;
  assert.equal((await u.api.post(lab('/revert'), { versionId: trimmed.id })).status, 200);
  assert.equal((await u.api.get(lab('/versions'))).json.versions.length, nBefore + 1, 'revert adds a version instead of rewriting history');
  assert.equal((await u.api.get(lab())).json.head.seq[9] === 'R', false);
  assert.equal((await u.api.post(lab('/clean'), { op: 'trim_region', from: 5, to: 99999 })).status, 400);
});

test('FASTA input has no quality scores: quality trimming is refused with a clear message', async () => {
  const r = await u.api.post('/api/lab/import', { projectId: u.projectId, text: `>plain\n${QUERY}\n` });
  const id = r.json.recordIds[0];
  const t = await u.api.post(`/api/lab/${id}/clean`, { op: 'trim_window' });
  assert.equal(t.status, 400); assert.match(t.json.error?.message ?? t.text, /no quality scores/i);
  assert.equal((await u.api.get(`/api/lab/${id}/inspect`)).json.hasQuality, false);
});

let blastOp = '';
test('BLAST: job runs through the queue, hits keep identity and coverage separate, filters and ranking are explained', async () => {
  const r = await u.api.post(lab('/blast'), { params: { db: 'core_nt', program: 'megablast', hitlist: 20, expect: 0.05 } });
  assert.equal(r.status, 200, r.text);
  const done = await waitJob(u.api, r.json.jobId, 60_000);
  assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const h = (await u.api.get(lab('/hits'))).json; blastOp = h.op.id;
  assert.equal(h.total, SUBJECTS.length); assert.equal(h.op.queryLength, (await u.api.get(lab())).json.head.length);
  const top = h.hits[0]; assert.ok(top.identityPct > 98 && top.coveragePct > 99 && top.bitScore > 0 && top.mismatches >= 0);
  assert.ok(top.hsps[0].qseq && top.hsps[0].hseq && top.hsps[0].midline, 'alignment view data is stored');
  assert.match(h.ranking, /bit score/);
  const f = (await u.api.get(lab('/hits?excludeEnvironmental=1&onePerSpecies=1&sort=identity'))).json;
  assert.ok(f.shown < h.total && f.hits.every((x: any) => !/uncultured/.test(x.organism)));
  assert.equal(new Set(f.hits.map((x: any) => x.taxId)).size, f.hits.length);
  assert.ok(f.hits.every((x: any, i: number, a: any[]) => i === 0 || a[i - 1].identityPct >= x.identityPct));
  // the BLAST request carried the real parameters, and no secret
  const post = calls.find((c) => c.method === 'POST' && /blast\.ncbi/.test(c.url))!;
  assert.match(post.body!, /DATABASE=core_nt/); assert.match(post.body!, /MEGABLAST=on/); assert.ok(!/api_key|apikey/i.test(post.body! + post.url));
  const op = (await u.api.get(lab(`/ops/${blastOp}`))).json.op;
  assert.equal(op.status, 'completed'); assert.equal(op.params.db, 'core_nt'); assert.ok(op.dbRetrievedAt || op.result.retrievedAt);
});

test('close relatives: one per species, environmental entries excluded with reasons, minus-strand hits returned in query orientation', async () => {
  const r = await u.api.post(lab('/relatives'), { params: { maxRelatives: 8, minCoverage: 80, minIdentity: 70 } });
  const done = await waitJob(u.api, r.json.jobId, 60_000);
  assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const ds = (await u.api.get(lab('/dataset'))).json;
  const ing = ds.members.filter((m: any) => m.role === 'ingroup');
  assert.deepEqual(ing.map((m: any) => m.organism).sort(), ['Alphus primus', 'Alphus quartus', 'Alphus secundus', 'Betus tertius']);
  assert.ok(ds.excluded.some((e: any) => /uncultured|environmental/.test(e.reason)) && ds.excluded.some((e: any) => /same species/.test(e.reason)));
  assert.ok(ing.every((m: any) => m.reasons.length >= 2 && m.accession && m.region));
  assert.equal(ds.members.find((m: any) => m.role === 'query').id, 'query');
  assert.ok(ing.find((m: any) => m.organism === 'Alphus secundus').region.strand === 'minus');
  // export the dataset FASTA and verify the minus-strand record is oriented like the query (high identity vs query, not its reverse complement)
  const fa = (await u.api.get(lab('/export/fasta?what=dataset'))).text.split('>').filter(Boolean).map((b) => { const [h, ...s] = b.split('\n'); return [h.trim(), s.join('')] as const; });
  const q = fa.find(([h]) => h.startsWith('Query'))![1]; const sec = fa.find(([h]) => h.includes('secundus'))![1];
  let same = 0; for (let i = 0; i < Math.min(q.length, sec.length); i++) if (q[i] === sec[i]) same++;
  assert.ok(same / Math.min(q.length, sec.length) > 0.9, `identity ${same / q.length}`);
  assert.ok(calls.some((c) => /seq_start=/.test(c.url) && /strand=2/.test(c.url)), 'minus-strand region requested from NCBI with strand=2');
});

let ogOp = '';
test('outgroup assistant: sister-lineage search, ≤5 explained candidates, honest exclusions; accepting is a user action', async () => {
  const r = await u.api.post(lab('/outgroups'), { params: { max: 5 } });
  const done = await waitJob(u.api, r.json.jobId, 60_000);
  assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const ds = (await u.api.get(lab('/dataset'))).json; const og = ds.outgroupAssistant; ogOp = og.opId;
  assert.match(og.entrez, /^txid100\[Organism:exp\] NOT txid500\[Organism:exp\]( NOT txid\d+\[Organism:exp\])*$/, 'family excluded, order searched, ingroup genera excluded too');
  assert.equal(og.rounds.length, 2, 'fewer than 3 candidates → the sister clade is widened once'); assert.match(og.warnings.join(' '), /widened to Metazoa/);
  assert.equal(og.scopes.ingroup.name, 'Famx'); assert.equal(og.scopes.outside.name, 'Ordo magnus');
  assert.deepEqual(og.candidates.map((c: any) => c.organism).sort(), ['Deltus primus', 'Gammus primus']);
  assert.ok(og.excluded.some((e: any) => /genus Gammus already represented/.test(e.reason)));
  assert.ok(og.excluded.some((e: any) => e.organism === 'Epsilonus mislabeled' && /as high as the ingroup's.*mislabeled/.test(e.reason)), 'a record as similar as the ingroup is rejected as an outgroup');
  assert.ok(!og.candidates.some((c: any) => c.organism === 'Epsilonus mislabeled'));
  assert.ok(og.warnings.some((w: string) => /Only 2 suitable/.test(w)), 'says honestly that fewer than 5 were found');
  assert.equal(ds.members.filter((m: any) => m.role === 'outgroup').length, 0, 'nothing is added without the user accepting');
  const acc = await u.api.post(lab('/dataset'), { action: 'add_candidates', opId: ogOp, ids: og.candidates.map((c: any) => c.id), role: 'outgroup' });
  assert.equal(acc.status, 200, acc.text);
  assert.equal((await u.api.get(lab('/dataset'))).json.members.filter((m: any) => m.role === 'outgroup').length, 2);
});

test('manual dataset edit by accession orients the reference like the query; duplicates rejected', async () => {
  const add = await u.api.post(lab('/dataset'), { action: 'add_accession', accession: 'KX000005', role: 'ingroup' });
  assert.equal(add.status, 200, add.text);
  assert.equal((await u.api.post(lab('/dataset'), { action: 'add_accession', accession: 'KX000005', role: 'ingroup' })).status, 400);
  const ids = (await u.api.get(lab('/dataset'))).json.members.filter((m: any) => m.accession === 'KX000005.1').map((m: any) => m.id);
  await u.api.post(lab('/dataset'), { action: 'remove', ids });
  assert.ok(!(await u.api.get(lab('/dataset'))).json.members.some((m: any) => m.accession === 'KX000005.1'));
  const hist = (await u.api.get(lab('/dataset'))).json.history; assert.ok(hist.length >= 4, 'each dataset change is its own version');
});

test('alignment: progressive + iterative, sequences intact, manual edits are logged separately', async () => {
  const r = await u.api.post(lab('/align'), { params: { method: 'iterative' } });
  const done = await waitJob(u.api, r.json.jobId, 60_000);
  assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const a = (await u.api.get(lab('/alignment'))).json;
  assert.equal(a.labels.length, 1 + 4 + 2); assert.ok(a.rows.every((x: string) => x.length === a.length));
  const ds = await u.api.get(lab('/export/fasta?what=dataset'));
  const members = new Map(ds.text.split('>').filter(Boolean).map((b) => { const [h, ...s] = b.split('\n'); return [h.trim(), s.join('')] as const; }));
  a.labels.forEach((l: string, i: number) => assert.equal(a.rows[i].replace(/-/g, ''), members.get(l)));
  const label = a.labels[1];
  const e = await u.api.post(lab('/align/edit'), { action: 'insert_gap', label, col: 100, n: 2 });
  assert.equal(e.status, 200, e.text);
  const a2 = (await u.api.get(lab('/alignment'))).json;
  assert.equal(a2.op.step, 'align_edit'); assert.equal(a2.manualEdits, 1); assert.ok(a2.length >= a.length);
  a2.labels.forEach((l: string, i: number) => assert.equal(a2.rows[i].replace(/-/g, ''), members.get(l)), 'editing only moves gaps');
  assert.equal((await u.api.post(lab('/align/edit'), { action: 'delete_gap', label, col: 0, n: 1 })).status, 400, 'residues cannot be deleted');
  const undoGap = await u.api.post(lab('/align/edit'), { action: 'delete_gap', label, col: 100, n: 2 });
  assert.equal(undoGap.status, 200);
});

test('pairwise alignment (global/local) is logged and the exported Biopython code gives the same score', async () => {
  const ds = (await u.api.get(lab('/dataset'))).json;
  const sub = ds.members.find((m: any) => m.organism === 'Alphus secundus');
  const g = await u.api.post(lab('/pairwise'), { memberId: sub.id, mode: 'global' });
  assert.equal(g.status, 200, g.text); assert.ok(g.json.alignment.identityPct > 90);
  const l = await u.api.post(lab('/pairwise'), { memberId: sub.id, mode: 'local', gapOpen: 6 });
  assert.equal(l.json.alignment.mode, 'local'); assert.ok(l.json.alignment.score >= g.json.alignment.score - 1);
  assert.equal((await u.api.post(lab('/pairwise'), { memberId: 'nope', mode: 'global' })).status, 400);
  assert.equal((await u.api.post(lab('/pairwise'), { memberId: sub.id, mode: 'global', gapOpen: -1 })).status, 400);
  for (const r of [g, l]) {
    const sc = (await u.api.get(lab(`/export/script?scope=op&op=${r.json.opId}`))).json;
    const out = py(sc.code, 'pair.py');
    const m = /alignment score: ([\d.]+) \(VierStation stored ([\d.]+)\)/.exec(out)!;
    assert.equal(Number(m[1]), Number(m[2]), out);
  }
});

test('tree job: NJ with bootstrap, outgroup rooting, interpretation with limitations', async () => {
  const r = await u.api.post(lab('/tree'), { params: { method: 'nj', distance: 'k2p', bootstrap: 30, rooting: 'outgroup' } });
  const done = await waitJob(u.api, r.json.jobId, 120_000);
  assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const t = (await u.api.get(lab('/tree'))).json.result;
  assert.equal(t.labels.length, 7); assert.equal(t.bootstrapDone, 30); assert.match(t.rooting, /outgroup/i);
  assert.ok(Object.keys(t.support).length >= 3);
  const it = t.interpretation;
  assert.ok(['species', 'genus'].includes(it.level), it.statement);
  assert.match(it.statement, /Alphus/); assert.equal(it.closestRelatives[0].organism, 'Alphus primus');
  assert.equal(it.outgroupsFormOwnClade, true);
  assert.ok(it.limitations.some((l: string) => /does not by itself prove/.test(l)) && it.limitations.some((l: string) => /Bootstrap values/.test(l)));
  assert.match(t.newick, /Query_isolate_17/);
});

test('ML and MP trees also run in workers (real progress, no invented percentages)', async () => {
  for (const method of ['mp', 'ml']) {
    const r = await u.api.post(lab('/tree'), { params: { method, bootstrap: 4, rooting: 'midpoint', mlModel: 'K80', mlGamma: false } });
    const done = await waitJob(u.api, r.json.jobId, 180_000);
    assert.equal(done.job.status, 'completed', `${method}: ${JSON.stringify(done.job.error)}`);
    assert.ok((await u.api.get(lab('/tree'))).json.result.score !== undefined);
  }
});

test('final identification is a recorded user decision, never automatic', async () => {
  const before = (await u.api.get(lab('/identification'))).json;
  assert.equal(before.decided, null); assert.ok(before.evidence.topHit && before.evidence.tree); assert.deepEqual(before.missing, []);
  assert.equal((await u.api.post(lab('/identification'), { taxon: '', rank: 'species', confidence: 'high' })).status, 400);
  const r = await u.api.post(lab('/identification'), { taxon: 'Alphus primus', rank: 'species', confidence: 'moderate', notes: 'Tree and BLAST agree; single marker only.' });
  assert.equal(r.status, 200);
  assert.equal((await u.api.get(lab('/identification'))).json.decided.taxon, 'Alphus primus');
  assert.equal((await u.api.post(lab('/identification'), { taxon: 'Alphus primus', rank: 'species', confidence: 'inconclusive', linkOrganism: true, taxId: 1001 })).status, 400, 'no organism link for an inconclusive conclusion');
  const lk = await u.api.post(lab('/identification'), { taxon: 'Alphus primus', rank: 'species', confidence: 'moderate', taxId: 1001, linkOrganism: true });
  assert.equal(lk.status, 200, lk.text); assert.ok(lk.json.organism.organismRecordId);
  const orgRec = (await u.api.get(`/api/records/${lk.json.organism.organismRecordId}`)).json;
  assert.ok(JSON.stringify(orgRec).includes('Alphus primus'));
  const links = (await u.api.get(`/api/records/${rid}`)).json;
  assert.ok(JSON.stringify(links).includes('user_supplied') && JSON.stringify(links).includes('identified as (user conclusion)'), 'the organism link is classed as the user\'s conclusion');
});

test('full NCBI record: preview shows what will be saved and changes nothing; saving is a job that creates a new record', async () => {
  const before = (await u.api.get(lab('/ops'))).json.ops.length;
  const pv = await u.api.get(lab('/ncbi/preview?accession=KX000001'));
  assert.equal(pv.status, 200, pv.text);
  assert.equal(pv.json.organism, 'Alphus primus'); assert.equal(pv.json.taxId, 1001); assert.equal(pv.json.references.length, 2);
  assert.equal(pv.json.references[0].pubmed, '12345678'); assert.ok(pv.json.willSave.length >= 3 && /Nothing is saved/.test(pv.json.willNotSave[0]));
  assert.equal((await u.api.get(lab('/ops'))).json.ops.length, before, 'preview must not log or modify anything');
  const sv = await u.api.post(lab('/ncbi/save'), { accession: 'KX000001' });
  const done = await waitJob(u.api, sv.json.jobId, 30_000);
  assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const saved = done.job.result.recordId;
  const rec = await u.api.get(`/api/records/${saved}`);
  assert.equal(rec.status, 200);
  const last = (await u.api.get(lab('/ops?step=ncbi_record'))).json.ops.pop();
  assert.equal(last.status, 'completed'); assert.equal(last.outputRef, saved);
});

// ---------------------------------------------------------------- exports built from the real stored history
test('Markdown change log is generated from the stored operations (counts, order, parameters, warnings)', async () => {
  const ops = (await u.api.get(lab('/ops'))).json.ops;
  const md = (await u.api.get(lab('/export/changelog'))).text;
  assert.match(md, /^# Sequence workflow history – isolate_17/);
  const rows = md.split('\n').filter((l) => /^\| \d+ \| \d{4}-/.test(l));
  assert.equal(rows.length, ops.length, 'one timeline row per stored operation');
  ops.forEach((o: any, i: number) => assert.ok(rows[i].includes(`| ${o.step} |`), `row ${i + 1} is ${o.step}`));
  for (const s of ['Raw (immutable)', 'NCBI BLAST similarity search', 'Retrieve close relatives', 'Outgroup selection assistant', 'Multiple alignment', 'Phylogenetic tree', 'Identification: Alphus primus', 'Undo', 'Redo']) assert.ok(md.includes(s), `contains ${s}`);
  assert.match(md, /position 10: [A-Z] → R/);
  assert.match(md, /Only 2 suitable outgroup candidate/);
  assert.ok(md.includes(sha((await u.api.get(lab())).json.head.seq).slice(0, 16)), 'current-sequence hash matches');
});

function py(code: string, name: string): string {
  const d = mkdtempSync(join(tmpdir(), 'vs-py-')); const f = join(d, name); writeFileSync(f, code, 'utf8');
  return execFileSync('python', [f], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, PYTHONUTF8: '1' } });
}
test('exported cleaning script reproduces the stored sequences exactly (executed in Python)', async () => {
  const ops = (await u.api.get(lab('/ops'))).json.ops;
  // a whole-workflow script compiles; network steps are not executed here
  const wf = (await u.api.get(lab('/export/script?scope=workflow'))).json;
  assert.ok(wf.code.includes('qblast') && wf.code.includes('trim_window') && !/api[_-]?key/i.test(wf.code));
  assert.equal(wf.reproducible, 'partial'); assert.ok(wf.notes.some((n: string) => /built-in aligner/.test(n)) && wf.notes.some((n: string) => /BLAST results depend/.test(n)));
  const d = mkdtempSync(join(tmpdir(), 'vs-py-')); writeFileSync(join(d, 'wf.py'), wf.code, 'utf8');
  execFileSync('python', ['-m', 'py_compile', join(d, 'wf.py')], { encoding: 'utf8' });
  // run only the import + cleaning portion (everything before the first network step)
  const cut = wf.code.indexOf('# NCBI BLAST similarity search');
  const head = wf.code.slice(0, wf.code.lastIndexOf('\n# ====', cut));
  const out = py(head, 'clean_only.py');
  assert.ok(!/MISMATCH/.test(out), out); assert.ok((out.match(/^OK /gm) ?? []).length >= 4, out);
  void ops;
});

test('exported tree script (NJ) reproduces the topology in Biopython', async () => {
  const tops = (await u.api.get(lab('/ops?step=tree'))).json.ops.filter((o: any) => o.params.method === 'nj');
  const nj = tops[tops.length - 1];
  const s = (await u.api.get(lab(`/export/script?scope=op&op=${nj.id}`))).json;
  const out = py(s.code + '\nprint("NEWICK:" + tree.format("newick").strip())\n', 'tree_only.py');
  const nw = /NEWICK:(.*)$/m.exec(out)![1];
  const stored = (await u.api.get(lab(`/tree?op=${nj.id}`))).json.result;
  const splitsOf = (nwk: string, names: string[]) => {
    let i = 0; const src = nwk.trim().replace(/;$/, '');
    const all = new Set<string>();
    const parse = (): string[] => {
      const leaves: string[] = [];
      if (src[i] === '(') { i++; for (;;) { leaves.push(...parse()); if (src[i] === ',') { i++; continue; } break; } i++; /* ')' */ }
      let label = ''; while (i < src.length && !',()'.includes(src[i])) label += src[i++];
      const name = label.replace(/:[-\d.eE]+$/, '').replace(/^[\d.]+(?=$)/, '');
      if (!leaves.length) return [name.replace(/:.*/, '')];
      if (leaves.length > 1 && leaves.length < names.length - 1) { const comp = names.filter((n) => !leaves.includes(n)); all.add((leaves.includes(names[0]) ? comp : leaves).slice().sort().join(',')); }
      return leaves;
    };
    parse(); return all;
  };
  const names = stored.labels as string[];
  const a = splitsOf(nw, names), b = splitsOf(stored.newick, names);
  const sym = [...a].filter((x) => !b.has(x)).length + [...b].filter((x) => !a.has(x)).length;
  // trees are rooted differently (outgroup vs Biopython's midpoint-style root), so compare unrooted bipartitions after folding the root split
  assert.ok(sym <= 2, `Robinson–Foulds difference ${sym}\nPy: ${nw}\nJS: ${stored.newick}`);
});

test('every cleaning operation is replayed exactly by the exported Python (all 9 operations, executed)', async () => {
  const rnd = (n: number, seed: number) => { let x = seed; return Array.from({ length: n }, () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return 'ACGT'[x % 4]; }).join(''); };
  const core = rnd(150, 99).split(''); core[40] = 'N'; core[41] = 'N'; core[90] = 'R';
  const seq = 'NNN' + core.join('') + 'NN';
  const qual = Array.from({ length: seq.length }, (_, i) => (i < 6 || i > seq.length - 7 ? 6 : i % 17 === 0 ? 12 : 34));
  const r = await u.api.post('/api/lab/import', { projectId: u.projectId, text: fastq(seq, qual, 'replay_all') });
  const id = r.json.recordIds[0];
  const steps: any[] = [{ op: 'reverse_complement' }, { op: 'trim_ambiguous_ends' }, { op: 'trim_mott', errorCutoff: 0.05 }, { op: 'mask_low_quality', threshold: 25 }, { op: 'remove_bases', chars: 'N' }, { op: 'edit_base', pos: 5, base: 'y' }, { op: 'trim_region', from: 3, to: 120, mode: 'keep' }, { op: 'trim_region', from: 10, to: 14, mode: 'remove' }, { op: 'mark_region', from: 2, to: 6, note: 'noisy' }, { op: 'trim_window', threshold: 15, window: 8, ends: 'both' }];
  for (const st of steps) { const x = await u.api.post(`/api/lab/${id}/clean`, st); assert.equal(x.status, 200, `${st.op}: ${x.text}`); }
  const ops = (await u.api.get(`/api/lab/${id}/ops?step=clean`)).json.ops;
  assert.ok(ops.length >= 9, `${ops.length} cleaning operations stored`);
  const sc = (await u.api.get(`/api/lab/${id}/export/script?scope=workflow`)).json;
  assert.equal(sc.reproducible, 'exact', JSON.stringify(sc.notes));
  const out = py(sc.code, 'replay_all.py');
  assert.ok(!/MISMATCH/.test(out), out); assert.ok((out.match(/^OK /gm) ?? []).length >= ops.length + 1, out);
});

test('AB1: chromatogram slice and ambiguity suggestions come from the real trace; FASTA has none', async () => {
  const bytes = readFileSync(join(here, 'fixtures/seqlab/3730.ab1'));
  const up = await u.api.req('POST', `/api/workspaces/${u.wsId}/files?name=3730.ab1`, bytes as unknown as Uint8Array, { 'content-type': 'application/octet-stream' });
  assert.equal(up.status, 200, up.text);
  const r = await u.api.post('/api/lab/import', { projectId: u.projectId, fileId: up.json.file.id });
  assert.equal(r.status, 200, r.text);
  const id = r.json.recordIds[0];
  const c = parseAb1(bytes);
  const slice = (await u.api.get(`/api/lab/${id}/chromatogram?from=10&to=40`)).json;
  assert.equal(slice.bases.length, 31); assert.equal(slice.bases[0].base, c.seq[9]); assert.equal(slice.traces.A.length, slice.pointTo - slice.pointFrom + 1);
  assert.equal(slice.rawLength, c.seq.length);
  const amb = (await u.api.get(`/api/lab/${id}/ambiguity?minRatio=0.3`)).json;
  assert.ok(amb.count >= 0 && Array.isArray(amb.items));
  assert.equal((await u.api.get(`/api/lab/${rid}/chromatogram?from=1&to=10`)).status, 400, 'FASTQ import has no chromatogram');
  void buildAb1;
});

test('existing records enter the lab through adoption with an explicit warning', async () => {
  const dna = u.tables.dna;
  const meta = (await u.api.get(`/api/tables/${dna}`)).json.fields as any[];
  const sf = meta.find((f) => f.key === 'sequence').id, nf = meta.find((f) => f.key === 'name').id;
  const mk = await u.api.post(`/api/tables/${dna}/records`, { fields: { [nf]: 'old record', [sf]: QUERY } });
  const id = mk.json.records[0].id;
  const ov = (await u.api.get(`/api/lab/${id}`)).json;
  assert.equal(ov.head.length, QUERY.length);
  const ops = (await u.api.get(`/api/lab/${id}/ops`)).json.ops;
  assert.ok(ops[0].warnings[0].includes('existed before the Sequence Lab'));
});

test('failed BLAST is logged as a failed operation with the reason, and can be re-run (supersedes)', async () => {
  const { lab: flags } = await import('./lab-upstream.ts');
  flags.failBlast = true;
  const r = await u.api.post(lab('/blast'), { params: {} });
  const done = await waitJob(u.api, r.json.jobId, 30_000);
  assert.equal(done.job.status, 'failed');
  const ops = (await u.api.get(lab('/ops?step=blast'))).json.ops;
  const last = ops[ops.length - 1]; assert.equal(last.status, 'failed'); assert.match(last.error, /Query too short|rejected/);
  flags.failBlast = false;
  const r2 = await u.api.post(lab('/blast'), { params: {} });
  assert.equal((await waitJob(u.api, r2.json.jobId, 60_000)).job.status, 'completed');
  const ops2 = (await u.api.get(lab('/ops?step=blast'))).json.ops;
  assert.equal(ops2.length, ops.length + 1, 'previous results are kept'); void OUTGROUPS;
});

test('"use selected BLAST hits as relatives" builds the ingroup from exactly the chosen hits and keeps the outgroups', async () => {
  const r = await u.api.post(lab('/relatives'), { params: { only: ['KX000004.1', 'KX000006.1'], maxRelatives: 2 } });
  const done = await waitJob(u.api, r.json.jobId, 60_000); assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const ds = (await u.api.get(lab('/dataset'))).json;
  assert.deepEqual(ds.members.filter((m: any) => m.role === 'ingroup').map((m: any) => m.accession).sort(), ['KX000004.1', 'KX000006.1']);
  assert.equal(ds.members.filter((m: any) => m.role === 'outgroup').length, 2, 'outgroups survive a relatives rebuild');
  assert.ok(ds.members.find((m: any) => m.accession === 'KX000004.1').reasons[0].includes('Selected by you'));
});

test('cancelling a running BLAST job stops it and the operation is logged as cancelled (not failed)', async () => {
  const r = await u.api.post(lab('/blast'), { params: {} });
  await new Promise((res) => setTimeout(res, 300)); // let it start (the scripted NCBI makes it wait ~1 s)
  assert.equal((await u.api.post(`/api/jobs/${r.json.jobId}/cancel`)).status, 200);
  const done = await waitJob(u.api, r.json.jobId, 20_000);
  assert.equal(done.job.status, 'cancelled');
  const last = (await u.api.get(lab('/ops?step=blast'))).json.ops.pop();
  assert.equal(last.status, 'cancelled'); assert.match(last.error, /Cancelled by the user/);
});

test('Entrez search falls back to the default ordering when NCBI answers 500 to sort=relevance (seen live)', async () => {
  const { setFetch } = await import('../server/integrations/http.ts');
  const { entrezSearch } = await import('../server/integrations/ncbi.ts');
  purgeCache();
  const seen: string[] = [];
  setFetch(async (url) => {
    const u = String(url); seen.push(u);
    if (/sort=relevance/.test(u)) return new Response('Internal Server Error', { status: 500 });
    if (/esearch/.test(u)) return new Response(JSON.stringify({ esearchresult: { idlist: ['7'] } }));
    return new Response(JSON.stringify({ result: { uids: ['7'], 7: { uid: '7', accessionversion: 'X00007.1' } } }));
  });
  try {
    const r = await entrezSearch('nuccore', 'some valid term', 3);
    assert.equal(r[0].accessionversion, 'X00007.1');
    assert.ok(seen.some((u) => /esearch.*sort=relevance/.test(u)) && seen.some((u) => /esearch/.test(u) && !/sort=/.test(u)), 'first with sort, then without');
  } finally { installLabUpstream(); purgeCache(); }
});

test('broadening: a taxon-restricted BLAST inside the best match\'s genus adds species the top hits did not reach, with reasons and the exact NCBI query recorded', async () => {
  const r = await u.api.post(lab('/relatives'), { params: { maxRelatives: 3, minCoverage: 80, minIdentity: 70, broaden: true, broadenMax: 2 } });
  const done = await waitJob(u.api, r.json.jobId, 90_000); assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const ds = (await u.api.get(lab('/dataset'))).json;
  const added = ds.members.filter((m: any) => m.source === 'taxon_blast' && m.role === 'ingroup');
  assert.equal(added.length, 2, 'broadenMax limits the extra species');
  assert.ok(added.every((m: any) => /^Alphus /.test(m.organism) && m.reasons[0].includes('taxon-restricted BLAST')));
  const op = (await u.api.get(lab('/ops?step=relatives'))).json.ops.pop();
  const full = (await u.api.get(lab(`/ops/${op.id}`))).json.op;
  assert.equal(full.result.rounds.length, 1); assert.match(full.result.rounds[0].entrez, /^txid8\d{3}\[Organism:exp\]( NOT txid\d+\[Organism:exp\])+$/);
  assert.equal(ds.members.filter((m: any) => m.role === 'outgroup').length, 2, 'outgroups are kept');
});

test('an aborted request that was waiting for the host rate limit gives its slot back (BLAST host allows one request at a time)', async () => {
  const { request, setFetch } = await import('../server/integrations/http.ts');
  setFetch(async () => new Response('ok'));
  try {
    await request('https://blast.ncbi.nlm.nih.gov/slot-1', {});
    const ac = new AbortController();
    const waiting = request('https://blast.ncbi.nlm.nih.gov/slot-2', { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(waiting);
    const third = await Promise.race([request('https://blast.ncbi.nlm.nih.gov/slot-3', {}), new Promise<null>((res) => setTimeout(() => res(null), 12_000))]);
    assert.ok(third && third.status === 200, 'the next request must not wait forever behind the aborted one');
  } finally { installLabUpstream(); purgeCache(); }
});

test('a taxon-restricted BLAST that NCBI answers with "0 database sequences searched" is repeated once as a fresh search', async () => {
  const { lab: flags } = await import('./lab-upstream.ts');
  flags.emptySubsetOnce = true; const before = calls.length;
  const r = await u.api.post(lab('/outgroups'), { params: { max: 5 } });
  const done = await waitJob(u.api, r.json.jobId, 90_000); assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const posts = calls.slice(before).filter((c) => c.method === 'POST' && /blast\.ncbi/.test(c.url));
  assert.ok(posts.length >= 3, `first search, its repeat, and the widened search: ${posts.length}`);
  assert.ok(!/JOB_TITLE/.test(posts[0].body!) && /JOB_TITLE=VierStation\+retry/.test(posts[1].body!), 'the repeat carries a distinct job title so NCBI does not return the cached empty RID');
  const og = (await u.api.get(lab('/dataset'))).json.outgroupAssistant; assert.ok(og.candidates.length >= 2, 'the repeat found the candidates');
  flags.emptySubsetOnce = false;
});

test('accession lookup retries with the other term spelling when NCBI answers 500 (seen live)', async () => {
  const { setFetch } = await import('../server/integrations/http.ts');
  const { nucSummary } = await import('../server/integrations/ncbi.ts');
  purgeCache();
  setFetch(async (url) => {
    const u = decodeURIComponent(String(url));
    if (/esearch/.test(u) && /\[Accession\]/.test(u)) return new Response('Internal Server Error', { status: 500 });
    if (/esearch/.test(u)) return new Response(JSON.stringify({ esearchresult: { idlist: ['42'] } }));
    return new Response(JSON.stringify({ result: { uids: ['42'], 42: { accessionversion: 'NR_000042.1', caption: 'NR_000042', title: 'x', organism: 'Test', taxid: 1, slen: 1500 } } }));
  });
  try { const s = await nucSummary('NR_000042.1'); assert.equal(s?.accession, 'NR_000042.1'); assert.equal(s?.length, 1500); }
  finally { installLabUpstream(); purgeCache(); }
});
