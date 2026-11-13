import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, newUser } from './helpers.ts';
import { mergeReverse, overlapAlign } from '../server/seqlab/merge.ts';
import { reverseComplement } from '../shared/sequence.ts';
import { mulberry32 } from '../server/phylo/run.ts';

const rnd = mulberry32(7);
const truth = Array.from({ length: 620 }, () => 'ACGT'[Math.floor(rnd() * 4)]).join('');
/** Simulate a read: sprinkle Ns (and optionally a few substitutions) like a poor Sanger/ABI call. */
function noisy(seq: string, nRate: number, subRate = 0, seed = 1) {
  const r = mulberry32(seed);
  return seq.split('').map((c) => { const x = r(); return x < nRate ? 'N' : x < nRate + subRate ? 'ACGT'.replace(c, '')[Math.floor(r() * 3)] : c; }).join('');
}
const state = (seq: string, qual: number[] | null = null) => ({ seq, qual, map: seq.split('').map((_, i) => i), marks: [] });

test('merge: forward + reverse reads recover the region and resolve each other\'s Ns', () => {
  const f = noisy(truth.slice(0, 420), 0.25, 0, 11), rRead = reverseComplement(noisy(truth.slice(230), 0.25, 0, 12)); // reverse read as sequenced (reverse strand)
  const res = mergeReverse(state(f), { reverseSeq: rRead });
  assert.equal(res.state.seq.length, 620, 'covers the whole amplicon');
  for (let i = 0; i < 620; i++) assert.ok(res.state.seq[i] === truth[i] || res.state.seq[i] === 'N', `position ${i + 1} is truth or N (got ${res.state.seq[i]})`);
  const nF = (f.match(/N/g) ?? []).length, nM = (res.state.seq.slice(0, 420).match(/N/g) ?? []).length; // Ns inside the stretch the forward read covers
  assert.ok(nM < nF * 0.8, `Ns in the forward-covered part fall (${nF} → ${nM}); only the 190-column overlap can be repaired`);
  assert.ok((res.details.ambiguousResolvedByOtherRead as number) > 20);
  assert.equal(res.details.overlapColumns, 190); assert.equal(res.details.overlapIdentityPct, 100);
  assert.equal(res.state.map!.filter((x) => x < 0).length, 200, 'bases that exist only in the reverse read are marked -1 in the origin map');
  assert.match(String(res.details.orientation), /reverse-complement scored/);
});

test('merge: a reverse read that is already complemented is detected automatically, and can be forced', () => {
  const f = truth.slice(0, 420), asIs = truth.slice(230);
  assert.equal(mergeReverse(state(f), { reverseSeq: asIs }).state.seq, truth); // auto → "as given"
  assert.equal(mergeReverse(state(f), { reverseSeq: asIs, orientation: 'as_is' }).state.seq, truth);
  assert.throws(() => mergeReverse(state(f), { reverseSeq: asIs, orientation: 'reverse_complement' }), /do not overlap reliably/);
});

test('merge: unrelated or non-overlapping reads are refused and nothing is invented', () => {
  const other = Array.from({ length: 300 }, () => 'ACGT'[Math.floor(rnd() * 4)]).join('');
  assert.throws(() => mergeReverse(state(truth.slice(0, 300)), { reverseSeq: reverseComplement(other) }), /do not overlap reliably/);
  assert.throws(() => mergeReverse(state(truth.slice(0, 200)), { reverseSeq: reverseComplement(truth.slice(400)) }), /do not overlap reliably/);
  assert.throws(() => mergeReverse(state(truth.slice(0, 200)), { reverseSeq: 'ACGT' }), /shorter than 30/);
});

test('merge: conflicting real bases use quality when it clearly differs, otherwise an IUPAC code', () => {
  const f = truth.slice(0, 300).split(''), rr = truth.slice(150, 450).split('');
  const pos = 200; // truth[pos] differs between the reads
  f[pos] = truth[pos] === 'A' ? 'C' : 'A'; // forward is wrong here
  const fq = new Array(300).fill(30), rq = new Array(300).fill(30);
  fq[pos] = 12; // forward is low quality at the conflict
  const rcRead = reverseComplement(rr.join('')), rcq = [...rq].reverse();
  const byQ = mergeReverse(state(f.join(''), fq), { reverseSeq: rcRead, reverseQual: rcq });
  assert.equal(byQ.state.seq[pos], truth[pos]); assert.equal(byQ.details.resolvedByQuality, 1); assert.ok(byQ.state.qual);
  fq[pos] = 28; // similar quality → no winner
  const iu = mergeReverse(state(f.join(''), fq), { reverseSeq: rcRead, reverseQual: rcq });
  assert.equal(iu.details.writtenAsIupac, 1); assert.ok(!'ACGT'.includes(iu.state.seq[pos])); assert.ok(iu.warnings.some((w) => /IUPAC/.test(w)));
});

test('overlap alignment finds the offset of two reads', () => {
  const a = truth.slice(0, 300), b = truth.slice(100, 400), aln = overlapAlign(a, b);
  assert.equal(aln.i0, 100); assert.equal(aln.j0, 0); assert.equal(aln.iEnd, 300); assert.equal(aln.jEnd, 200); assert.equal(aln.score, 400);
});

let base = '', close: () => Promise<void>;
let u: Awaited<ReturnType<typeof newUser>>;
before(async () => { const s = await boot(); base = s.base; close = s.close; u = await newUser(base); });
after(async () => { await close(); });

test('merge via the API is logged, reversible, traceable to the reverse read, and the exported Python reproduces it exactly', async () => {
  const f = noisy(truth.slice(0, 420), 0.22, 0, 21), rRead = reverseComplement(noisy(truth.slice(230), 0.22, 0, 22));
  const imp = await u.api.post('/api/lab/import', { projectId: u.projectId, text: `>sample_F\n${f}` });
  const id = imp.json.recordIds[0], L = (p = '') => `/api/lab/${id}${p}`;
  await u.api.post(L('/clean'), { op: 'trim_ambiguous_ends' });
  const m = await u.api.post(L('/merge-reverse'), { text: `>sample_R\n${rRead}`, name: 'sample_R' });
  assert.equal(m.status, 200, JSON.stringify(m.json)); assert.match(m.json.summary, /Merged with the reverse read/);
  const o = (await u.api.get(L())).json; assert.equal(o.head.length, 620); assert.equal(o.raw.length, 420, 'the raw forward read is untouched');
  // the reverse read exists as its own immutable record
  const rr = (await u.api.get(`/api/lab/${m.json.reverseRecordId}`)).json; assert.equal(rr.raw.length, rRead.length);
  const ops = (await u.api.get(L('/ops'))).json.ops; const mop = ops.find((x: any) => x.params?.op === 'merge_reverse');
  assert.ok(mop && mop.params.reverseRecordId === m.json.reverseRecordId && mop.step === 'clean');
  const detail = (await u.api.get(L(`/ops/${mop.id}`))).json.op; assert.ok(detail.changes.overlapColumns > 100 && detail.changes.ambiguousResolvedByOtherRead > 10);
  // bad reverse read: error, history unchanged
  const bad = await u.api.post(L('/merge-reverse'), { text: '>x\n' + 'ACGTTGCAAC'.repeat(8) });
  assert.equal(bad.status, 400); assert.match(JSON.stringify(bad.json), /do not overlap reliably/);
  assert.equal((await u.api.get(L('/ops'))).json.ops.length, ops.length);
  // exported script reproduces the merged sequence (each cleaning step asserts the stored hash)
  const sc = (await u.api.get(L('/export/script?scope=workflow'))).json;
  assert.ok(sc.code.includes('merge_reverse('));
  const d = mkdtempSync(join(tmpdir(), 'vs-merge-')); writeFileSync(join(d, 'wf.py'), sc.code, 'utf8');
  const out = execFileSync('python', [join(d, 'wf.py')], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, PYTHONUTF8: '1' } });
  assert.ok(!/MISMATCH/.test(out), out); assert.ok((out.match(/^OK /gm) ?? []).length >= 2, out);
  // undo restores the forward-only sequence
  await u.api.post(L('/undo'), {}); assert.ok((await u.api.get(L())).json.head.length <= 420, 'back to the forward-only sequence');
});

test('merge-pair: the combined read becomes ONE new record that names its sources; the source reads stay untouched and are grouped under it', async () => {
  const f = noisy(truth.slice(0, 420), 0.22, 0, 31), rRead = reverseComplement(noisy(truth.slice(230), 0.22, 0, 32));
  const a = (await u.api.post('/api/lab/import', { projectId: u.projectId, text: `>sampleX\n${f}` })).json.recordIds[0];
  const b = (await u.api.post('/api/lab/import', { projectId: u.projectId, text: `>sampleX_rev\n${rRead}` })).json.recordIds[0];
  // the picker lists both DNA records
  const pick = (await u.api.get(`/api/lab/dna-records?project=${u.projectId}`)).json.records;
  assert.ok(pick.find((x: any) => x.id === a) && pick.find((x: any) => x.id === b));
  const m = await u.api.post('/api/lab/merge-pair', { forwardRecordId: a, reverseRecordId: b });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  const id = m.json.recordId, L = (p = '') => `/api/lab/${id}${p}`;
  assert.equal(m.json.name, `Merged: sampleX (${a.slice(-6)}) + sampleX_rev (${b.slice(-6)})`, 'default name carries both names and short record ids');
  // the merged record: raw = consensus, 620 bp, history says where it came from
  const ov = (await u.api.get(L())).json; assert.equal(ov.raw.length, 620); assert.equal(ov.meta.source, 'merged');
  const imp = (await u.api.get(L('/ops'))).json.ops[0]; assert.equal(imp.step, 'import'); assert.equal(imp.params.forwardRecordId, a); assert.equal(imp.params.reverseRecordId, b);
  // the sources are unchanged and know about the merge
  for (const [rid, len] of [[a, 420], [b, rRead.length]] as const) {
    const o = (await u.api.get(`/api/lab/${rid}`)).json; assert.equal(o.raw.length, len); assert.equal(o.head.length, len);
    assert.ok((await u.api.get(`/api/lab/${rid}/ops`)).json.ops.some((x: any) => x.step === 'merged' && x.params.mergedRecordId === id));
  }
  // list: merged record points at its parts, parts point at the merged record
  const list = (await u.api.get(`/api/lab?project=${u.projectId}`)).json.records;
  const lm = list.find((x: any) => x.id === id); assert.equal(lm.mergedFrom.forward.id, a); assert.equal(lm.mergedFrom.reverse.id, b);
  assert.equal(list.find((x: any) => x.id === a).mergedInto[0].id, id); assert.equal(list.find((x: any) => x.id === b).mergedInto[0].id, id);
  // the DNA table row says how it was made
  const rec = (await u.api.get(`/api/records/${id}`)).json; assert.match(JSON.stringify(rec), /Merged forward \+ reverse/);
  // a custom name is honoured; unrelated reads are refused and create nothing
  const named = await u.api.post('/api/lab/merge-pair', { forwardRecordId: a, reverseRecordId: b, name: 'My amplicon 5 Nov' }); assert.equal(named.json.name, 'My amplicon 5 Nov');
  const before = (await u.api.get(`/api/lab?project=${u.projectId}`)).json.records.length;
  const bad = await u.api.post('/api/lab/merge-pair', { forwardRecordId: a, reverseText: '>x\n' + 'ACGTTGCAAC'.repeat(8) }); assert.equal(bad.status, 400);
  assert.equal((await u.api.get(`/api/lab?project=${u.projectId}`)).json.records.length, before, 'a refused merge leaves nothing behind: no merged record and no stray reverse record');
  assert.equal((await u.api.post('/api/lab/merge-pair', { forwardRecordId: a, reverseRecordId: a })).status, 400);
  // the exported script embeds BOTH reads and reproduces the merged sequence exactly
  const sc = (await u.api.get(L('/export/script?scope=workflow'))).json; assert.ok(sc.code.includes('forward_seq =') && sc.code.includes('reverse_seq ='));
  const d = mkdtempSync(join(tmpdir(), 'vs-pair-')); writeFileSync(join(d, 'wf.py'), sc.code, 'utf8');
  const out = execFileSync('python', [join(d, 'wf.py')], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, PYTHONUTF8: '1' } });
  assert.ok(!/MISMATCH/.test(out) && /OK .*merged forward \+ reverse/.test(out), out);
});
