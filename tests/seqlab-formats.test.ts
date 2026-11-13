import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAb1, buildAb1, parseFastq, parseSequenceText, sniff } from '../server/seqlab/formats.ts';
import * as C from '../server/seqlab/clean.ts';
import { reverseComplement } from '../shared/sequence.ts';

const here = dirname(fileURLToPath(import.meta.url));
const AB1 = readFileSync(join(here, 'fixtures/seqlab/3730.ab1'));
const st = (seq: string, qual: number[] | null = null): C.SeqState => ({ seq, qual, map: C.initialMap(seq.length), marks: [] });

test('AB1 parser agrees with Biopython on a real 3730 trace (bases, qualities, peak positions, trace points)', () => {
  const c = parseAb1(AB1);
  const dir = mkdtempSync(join(tmpdir(), 'vs-ab1-'));
  const f = join(dir, 'cmp.py');
  writeFileSync(f, `import json, sys
from Bio import SeqIO
r = SeqIO.read(sys.argv[1], "abi")
raw = r.annotations["abif_raw"]
print(json.dumps({"seq": str(r.seq), "qual": r.letter_annotations["phred_quality"], "ploc": list(raw["PLOC2"]), "n": len(raw["DATA9"]), "a": list(raw["DATA10"][:50]), "order": raw["FWO_1"].decode()}))
`);
  const bio = JSON.parse(execFileSync('python', [f, join(here, 'fixtures/seqlab/3730.ab1')], { encoding: 'utf8' }));
  assert.equal(c.seq, bio.seq); assert.deepEqual(c.qual, bio.qual); assert.deepEqual(c.ploc, bio.ploc); assert.equal(c.points, bio.n);
  assert.equal(c.order, bio.order.toUpperCase());
  assert.equal(c.seq.length, c.qual.length); assert.equal(sniff('x.ab1', AB1.subarray(0, 64)), 'ab1');
});

test('AB1 builder output parses back identically; corrupt or truncated files fail with a readable error', () => {
  const seq = 'ACGTACGTAC', qual = [10, 20, 30, 40, 50, 60, 10, 20, 30, 40];
  const mk = (b: string) => Array.from({ length: 10 * 8 }, (_, i) => (Math.floor(i / 8) < seq.length && seq[Math.floor(i / 8)] === b && i % 8 === 4 ? 900 : 5));
  const buf = buildAb1({ seq, qual, traces: { A: mk('A'), C: mk('C'), G: mk('G'), T: mk('T') }, ploc: Array.from({ length: 10 }, (_, i) => i * 8 + 4), sample: 'unit' });
  const c = parseAb1(buf);
  assert.equal(c.seq, seq); assert.deepEqual(c.qual, qual); assert.equal(c.meta.sample, 'unit'); assert.equal(c.points, 80);
  assert.ok(c.secondary.every((s) => s.ratio < 0.05), 'clean synthetic peaks have no second peak');
  assert.throws(() => parseAb1(Buffer.from('not an ab1 file at all, really not')), /ABIF/);
  assert.throws(() => parseAb1(buf.subarray(0, 60)), /truncated|directory|missing/i);
});

test('FASTQ: Phred+33 and +64, multi-read files, mismatched lengths rejected, FASTA/protein handling', () => {
  const r = parseFastq('@r1 desc\nACGT\n+\nIIII\n@r2\nGGCC\n+\n!!II\n');
  assert.equal(r.length, 2); assert.deepEqual(r[0].qual, [40, 40, 40, 40]); assert.deepEqual(r[1].qual, [0, 0, 40, 40]); assert.equal(r[0].id, 'r1');
  const p64 = parseFastq('@x\nACGT\n+\nhhhh\n');
  assert.deepEqual(p64[0].qual, [40, 40, 40, 40]); assert.ok(p64[0].warnings.some((w) => /Phred\+64/.test(w)));
  assert.throws(() => parseFastq('@x\nACGT\n+\nIII\n'), /length|quality/i);
  const fa = parseSequenceText('>a\nACGU\n>b\nGGTT\n');
  assert.equal(fa.length, 2); assert.equal(fa[0].seq, 'ACGT'); assert.equal(fa[0].qual, null); assert.ok(fa[0].warnings.some((w) => /U|RNA/i.test(w)));
  assert.throws(() => parseSequenceText('>p\nMKVLAAGIVGLLLAQPSTDEW\n'), /protein/i);
  assert.equal(parseSequenceText('acg tta\n gca').length, 1);
});

test('trimming algorithms on constructed quality profiles', () => {
  // good middle, bad ends
  const q = [...Array(12).fill(5), ...Array(30).fill(38), ...Array(14).fill(6)];
  const seq = 'N'.repeat(12) + 'ACGT'.repeat(7) + 'AC' + 'N'.repeat(14);
  const w = C.trimWindow(st(seq, q), 20, 10, 'both');
  assert.equal(w.state.seq, 'ACGT'.repeat(7) + 'AC'); assert.equal(w.state.qual!.length, 30); assert.equal((w.details as any).removed5, 12); assert.equal((w.details as any).removed3, 14);
  assert.deepEqual(w.state.map, Array.from({ length: 30 }, (_, i) => 12 + i), 'map points back into the raw read');
  const m = C.trimMott(st(seq, q), 0.05); assert.equal(m.state.seq, 'ACGT'.repeat(7) + 'AC');
  assert.throws(() => C.trimWindow(st('ACGT'.repeat(5), Array(20).fill(5)), 20, 10), /No \d+-base window/);
  assert.throws(() => C.trimWindow(st("ACGT")), /no quality/i);
  const e = C.trimWindow(st(seq, q), 20, 10, '3'); assert.equal(e.state.seq.startsWith('NNNN'), true, '3′-only leaves the 5′ end alone');
  assert.equal(C.trimAmbiguousEnds(st('NNACGTRN')).state.seq, 'ACGT'); assert.equal(C.trimAmbiguousEnds(st('ACGT')).changes.length, 0);
});

test('editing operations keep qualities, maps and marks consistent', () => {
  const s: C.SeqState = { seq: 'AACCGGTTAACC', qual: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], map: C.initialMap(12), marks: [{ start: 3, end: 6, note: 'x' }] };
  const r = C.removeBases(s, 'C'); assert.equal(r.state.seq, 'AAGGTTAA'); assert.deepEqual(r.state.qual, [1, 2, 5, 6, 7, 8, 9, 10]); assert.deepEqual(r.state.map, [0, 1, 4, 5, 6, 7, 8, 9]); assert.equal(r.changes.length, 4);
  assert.deepEqual(r.state.marks, [{ start: 3, end: 4, note: 'x' }], 'a mark shrinks with the bases it covered');
  const ed = C.editBase(s, 5, 'r'); assert.equal(ed.state.seq[4], 'R'); assert.equal(ed.changes[0].from, 'G'); assert.match(ed.summary, /A\/G/);
  assert.throws(() => C.editBase(s, 5, 'Z'), /IUPAC/); assert.throws(() => C.editBase(s, 99, 'A'), /Position/);
  const rc = C.reverseComplementOp(s); assert.equal(rc.state.seq, reverseComplement(s.seq)); assert.deepEqual(rc.state.qual, [...s.qual!].reverse()); assert.deepEqual(rc.state.map, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]); assert.deepEqual(rc.state.marks, [{ start: 7, end: 10, note: 'x' }]);
  const rg = C.trimRegion(s, 3, 6, 'remove'); assert.equal(rg.state.seq, 'AATTAACC'); assert.equal(rg.state.marks.length, 0);
  const mk = C.maskLowQuality(s, 4); assert.equal(mk.state.seq, 'NNNCGGTTAACC'); assert.equal(mk.state.seq.length, s.seq.length);
  assert.throws(() => C.removeBases(st('AAAA'), 'A'), /entire sequence/);
  assert.equal(C.codeFor('AG'), 'R'); assert.equal(C.codeFor('GA'), 'R'); assert.equal(C.codeFor('ACGT'), 'N'); assert.equal(C.codeFor('AA'), 'A');
});

test('diffAgainstRaw reports edits and removed regions through the map, also after reverse-complement', () => {
  const raw = 'ACGTACGTACGT';
  let s = st(raw);
  s = C.trimRegion(s, 3, 12, 'keep').state; s = C.editBase(s, 2, 'N').state;
  const d: any = C.diffAgainstRaw(raw, s);
  assert.equal(d.available, true); assert.deepEqual(d.removed, [[1, 2]]); assert.equal(d.editCount, 1); assert.equal(d.edits[0].rawPos, 4);
  const rc = C.reverseComplementOp(C.trimRegion(st(raw), 3, 12, 'keep').state).state;
  const d2: any = C.diffAgainstRaw(raw, rc); assert.equal(d2.editCount, 0); assert.equal(d2.reversed, true);
});
