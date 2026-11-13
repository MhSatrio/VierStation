import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMsa, defaultMsa, spScore, alignProfiles } from '../server/seqlab/msa.ts';
import { pairwise, defaultParams } from '../server/analysis/align.ts';
import { mulberry32 } from '../server/phylo/run.ts';

function evolve(root: string, rng: () => number, subs: number, indels: number): string {
  let s = root.split('');
  for (let i = 0; i < subs; i++) { const p = Math.floor(rng() * s.length); s[p] = 'ACGT'[Math.floor(rng() * 4)]; }
  for (let i = 0; i < indels; i++) {
    const p = Math.floor(rng() * s.length);
    if (rng() < 0.5) s.splice(p, 1 + Math.floor(rng() * 3)); else s.splice(p, 0, ...Array.from({ length: 1 + Math.floor(rng() * 3) }, () => 'ACGT'[Math.floor(rng() * 4)]));
  }
  return s.join('');
}
const makeSet = (n: number, len: number, seed: number) => {
  const rng = mulberry32(seed), root = Array.from({ length: len }, () => 'ACGT'[Math.floor(rng() * 4)]).join('');
  const mid = [evolve(root, rng, 15, 3), evolve(root, rng, 15, 3)];
  const seqs = Array.from({ length: n }, (_, i) => evolve(mid[i % 2], rng, 8, 2));
  return { labels: seqs.map((_, i) => `s${i}`), seqs };
};

test('progressive MSA keeps every sequence intact and rows equal length', () => {
  const { labels, seqs } = makeSet(8, 400, 1);
  const r = runMsa(labels, seqs, defaultMsa());
  assert.equal(r.rows.length, 8);
  for (const row of r.rows) assert.equal(row.length, r.length);
  r.rows.forEach((row, i) => assert.equal(row.replace(/-/g, ''), seqs[i]));
  assert.ok(r.rows.every((row, i) => row.length === r.rows[0].length && i >= 0));
  // no all-gap column survives
  for (let c = 0; c < r.length; c++) assert.ok(r.rows.some((row) => row[c] !== '-'));
});

test('two-sequence profile alignment reaches the optimal pairwise score (end gaps penalised)', () => {
  const { seqs } = makeSet(2, 300, 7);
  const o = { ...defaultMsa(), freeEndGaps: false };
  const [a, b] = alignProfiles([seqs[0]], [seqs[1]], o);
  const pw = pairwise(seqs[0], seqs[1], { ...defaultParams('dna', 'global') });
  // same scoring scheme → same optimum (spScore counts end gaps with the same affine rule)
  assert.equal(Math.round(spScore([a, b], o)), Math.round(pw.score));
});

test('free end gaps let a short read align inside a longer one without penalty', () => {
  const long = 'ACGTTGCAAGGCTTACCGGATTACAGGCTTAACCGGTTAAGCTAGCTAGGATCCA';
  const short = long.slice(10, 40);
  const [a, b] = alignProfiles([long], [short], defaultMsa());
  assert.equal(b.replace(/-/g, ''), short);
  assert.equal(a.replace(/-/g, ''), long);
  assert.match(b, /^-{10}[ACGT]{30}-+$/);
});

test('iterative refinement never lowers the sum-of-pairs score and logs each round', () => {
  const { labels, seqs } = makeSet(10, 350, 3);
  const prog = runMsa(labels, seqs, defaultMsa());
  const iter = runMsa(labels, seqs, { ...defaultMsa(), method: 'iterative' });
  assert.ok(iter.spScore >= prog.spScore - 1e-6, `${iter.spScore} < ${prog.spScore}`);
  assert.ok(iter.iterations.length >= 1);
  for (let i = 1; i < iter.iterations.length; i++) assert.ok(iter.iterations[i].spScore >= iter.iterations[i - 1].spScore);
  iter.rows.forEach((row, i) => assert.equal(row.replace(/-/g, ''), seqs[i]));
});

test('identical sequences align without gaps and report full conservation', () => {
  const s = 'ACGTACGTTAGCTAGCTAGGATCGATCGATTTAGC'.repeat(3);
  const r = runMsa(['a', 'b', 'c'], [s, s, s], defaultMsa());
  assert.ok(r.rows.every((x) => x === s));
  assert.ok(r.conservation.every((c) => c === 1));
});

test('cancellation stops the aligner', () => {
  const { labels, seqs } = makeSet(8, 300, 5);
  assert.throws(() => runMsa(labels, seqs, defaultMsa(), { isCancelled: () => true }), /Cancelled/);
});
