import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultParams, msa, pairwise, scorePair, identityOverAligned } from '../server/analysis/align.ts';
import type { AlignParams } from '../server/analysis/align.ts';
import { correlationMatrix, describe, neighborJoining, newick, pca, pearson, spearman, upgma, welch, jcDistance, clusterOrder } from '../server/analysis/stats.ts';
import type { TreeNode } from '../server/analysis/stats.ts';
import { compute } from '../server/analysis/compute.ts';
import type { AnalysisInput } from '../server/analysis/compute.ts';
import { generateCode } from '../server/analysis/codegen.ts';
import type { CodeSpec } from '../server/analysis/codegen.ts';

// -------- deterministic PRNG so "random" tests are reproducible --------
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const randSeq = (r: () => number, n: number, alpha: string) => Array.from({ length: n }, () => alpha[Math.floor(r() * alpha.length)]).join('');
const mutate = (r: () => number, s: string, alpha: string, rate: number) => {
  let out = '';
  for (const ch of s) { const x = r(); if (x < rate / 3) continue; else if (x < (2 * rate) / 3) out += ch + alpha[Math.floor(r() * alpha.length)]; else if (x < rate) out += alpha[Math.floor(r() * alpha.length)]; else out += ch; }
  return out;
};

/** Independent scorer: recompute an alignment's score from its two gapped strings with the affine model. */
function rescore(a: string, b: string, p: AlignParams): number {
  let s = 0, gapA = false, gapB = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-') { s -= gapA ? p.gapExtend : p.gapOpen; gapA = true; gapB = false; }
    else if (b[i] === '-') { s -= gapB ? p.gapExtend : p.gapOpen; gapB = true; gapA = false; }
    else { s += scorePair(a[i], b[i], p); gapA = gapB = false; }
  }
  return s;
}
/** Independent reference: textbook Needleman-Wunsch / Smith-Waterman with a LINEAR gap penalty (== Gotoh when open == extend). */
function linearScore(A: string, B: string, p: AlignParams, local: boolean): number {
  const g = p.gapOpen;
  const M = Array.from({ length: A.length + 1 }, (_, i) => new Array(B.length + 1).fill(0).map((_, j) => (local ? 0 : i === 0 ? -g * j : j === 0 ? -g * i : 0)));
  let best = 0;
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++) {
    let v = Math.max(M[i - 1][j - 1] + scorePair(A[i - 1], B[j - 1], p), M[i - 1][j] - g, M[i][j - 1] - g);
    if (local) v = Math.max(0, v);
    M[i][j] = v; best = Math.max(best, v);
  }
  return local ? best : M[A.length][B.length];
}

test('pairwise alignment: hand-computed cases', () => {
  const p = defaultParams('dna'); // match +2, mismatch -3, gap open 5, extend 2
  const same = pairwise('ACGTACGT', 'ACGTACGT', p);
  assert.deepEqual([same.score, same.identityPct, same.gaps], [16, 100, 0]);
  const ins = pairwise('AAAATTTT', 'AAAACTTTT', p);
  assert.equal(ins.score, 8 * 2 - 5); assert.equal(ins.gaps, 1); assert.equal(ins.a, 'AAAA-TTTT');
  const ins2 = pairwise('AAAATTTT', 'AAAACCTTTT', p);
  assert.equal(ins2.score, 16 - 5 - 2, 'a gap of length 2 costs open + extend');
  const loc = pairwise('TTTTACGTACGTTTTT', 'GGGGACGTACGGGGG', { ...p, mode: 'local' });
  assert.equal(loc.score, 14); assert.equal(loc.a, 'ACGTACG');
  assert.equal(pairwise('ACGT', 'TTTT', { ...p, mode: 'local' }).score, 2, 'single T matches');
  assert.throws(() => pairwise('A'.repeat(9000), 'A'.repeat(9000), p), /too long/);
});

test('pairwise alignment: matches an independent reference on 300 random pairs (global + local, DNA + protein)', () => {
  const r = rng(42);
  for (let k = 0; k < 300; k++) {
    const protein = k % 2 === 1, local = k % 3 === 0;
    const alpha = protein ? 'ACDEFGHIKLMNPQRSTVWY' : 'ACGT';
    const a = randSeq(r, 5 + Math.floor(r() * 40), alpha), b = mutate(r, a, alpha, 0.3) || 'A';
    const base = defaultParams(protein ? 'protein' : 'dna', local ? 'local' : 'global');
    const lin = { ...base, gapOpen: base.gapExtend }; // linear gaps for the reference comparison
    assert.equal(pairwise(a, b, lin).score, linearScore(a, b, lin, local), `linear-gap score ${a} / ${b}`);
    const al = pairwise(a, b, base); // real affine penalties: the reported score must equal the score recomputed from the strings
    assert.equal(al.score, rescore(al.a, al.b, base), `affine rescoring ${local ? 'local' : 'global'} ${a} / ${b}`);
    assert.equal(al.a.replace(/-/g, ''), local ? a.slice(al.startA, al.endA) : a, 'gapless alignment string equals the input (or its aligned slice)');
    assert.equal(al.b.replace(/-/g, ''), local ? b.slice(al.startB, al.endB) : b);
    assert.equal(al.a.length, al.b.length);
  }
});

test('protein alignment uses BLOSUM62: classic example and symmetry', () => {
  const p = defaultParams('protein', 'local');
  assert.equal(scorePair('W', 'W', p), 11); assert.equal(scorePair('A', 'R', p), -1); assert.equal(scorePair('I', 'L', p), 2);
  const a = pairwise('HEAGAWGHEE', 'PAWHEAE', p), b = pairwise('PAWHEAE', 'HEAGAWGHEE', p);
  assert.equal(a.score, b.score);
  assert.ok(a.score >= 15, 'at least the ungapped AW core');
  const g = pairwise('MKVLAAGIVGLLLAQP', 'MKVLAAGIVGLLLAQP', defaultParams('protein'));
  assert.equal(g.identityPct, 100); assert.equal(g.similarityPct, 100);
});

test('multiple alignment: equal-length rows, gap removal recovers every input, conservation is sane', () => {
  const r = rng(7);
  const root = randSeq(r, 60, 'ACGT');
  const seqs = [root, mutate(r, root, 'ACGT', 0.1), mutate(r, root, 'ACGT', 0.1), mutate(r, root, 'ACGT', 0.15), mutate(r, root, 'ACGT', 0.05)];
  const m = msa(seqs.map((_, i) => `s${i}`), seqs, defaultParams('dna'));
  assert.equal(new Set(m.rows.map((x) => x.length)).size, 1);
  m.rows.forEach((row, i) => assert.equal(row.replace(/-/g, ''), seqs[i]));
  assert.ok(m.conservation.every((c) => c > 0 && c <= 1));
  assert.ok(m.conservation.filter((c) => c === 1).length > 25, 'closely related sequences are mostly conserved');
  assert.equal(m.consensus.length, m.length);
  assert.throws(() => msa(['a'], ['ACGT'], defaultParams('dna')), /at least two/);
  assert.ok(identityOverAligned(m.rows[0], m.rows[0]) === 1);
});

test('statistics: describe, correlation, Welch t-test (matches R t.test on the sleep data)', () => {
  const d = describe([1, 2, 3, 4, 5, null]);
  assert.deepEqual([d.n, d.mean, d.median, d.min, d.max, d.missing], [5, 3, 3, 1, 5, 1]);
  assert.ok(Math.abs(d.sd! - Math.SQRT2 * 1.1180339887) < 1e-9 || Math.abs(d.sd! - 1.5811388300841898) < 1e-12);
  assert.equal(describe([]).mean, null);
  assert.equal(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1);
  assert.ok(Math.abs(pearson([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]) + 1) < 1e-12);
  assert.equal(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25]), 1, 'monotone => rho 1');
  assert.ok(Math.abs(spearman([1, 2, 2, 4], [1, 3, 3, 9]) - 1) < 1e-12, 'ties get average ranks');
  const cm = correlationMatrix([[1, 2, 3, null], [2, 4, 6, 8]], 'pearson');
  assert.equal(cm[0][1], 1, 'pairwise-complete observations');
  // R: t.test(extra ~ group, data = sleep): t = -1.8608, df = 17.776, p-value = 0.07939
  const g1 = [0.7, -1.6, -0.2, -1.2, -0.1, 3.4, 3.7, 0.8, 0.0, 2.0], g2 = [1.9, 0.8, 1.1, 0.1, -0.1, 4.4, 5.5, 1.6, 4.6, 3.4];
  const w = welch(g1, g2)!;
  assert.ok(Math.abs(w.t - -1.8608) < 5e-4, `t=${w.t}`); assert.ok(Math.abs(w.df - 17.776) < 5e-3, `df=${w.df}`); assert.ok(Math.abs(w.p - 0.07939) < 5e-5, `p=${w.p}`);
  assert.equal(welch([1], [2, 3]), null);
});

test('PCA matches the textbook example (Smith 2002) and handles missing values / constant columns', () => {
  const X = [[2.5, 2.4], [0.5, 0.7], [2.2, 2.9], [1.9, 2.2], [3.1, 3.0], [2.3, 2.7], [2, 1.6], [1, 1.1], [1.5, 1.6], [1.1, 0.9]];
  const r = pca(X, { scale: false, components: 2 });
  assert.ok(Math.abs(r.eigenvalues[0] - 1.28403) < 1e-4); assert.ok(Math.abs(r.eigenvalues[1] - 0.04908) < 1e-4);
  assert.ok(Math.abs(Math.abs(r.loadings[0][0]) - 0.6779) < 1e-3 && Math.abs(Math.abs(r.loadings[0][1]) - 0.7352) < 1e-3);
  assert.ok(Math.abs(r.explained[0] - 0.9632) < 1e-3);
  assert.ok(r.loadings[0].reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0) > 0, 'sign convention');
  const line = pca([[1, 2], [2, 4], [3, 6], [4, 8]], { scale: false, components: 2 });
  assert.ok(line.explained[0] > 0.9999);
  const withNa = pca([[1, 2, 1], [2, null, 2], [3, 6, 5], [4, 8, 4]], { scale: true, components: 2 });
  assert.equal(withNa.scores.length, 4);
  assert.throws(() => pca([[1, 2], [2, 3]], { scale: true }), /at least 3 rows/);
  assert.doesNotThrow(() => pca([[1, 5, 1], [2, 5, 3], [3, 5, 2], [4, 5, 9]], { scale: true }), 'constant column does not produce NaN');
});

function leafPaths(t: TreeNode): Map<string, Map<string, number>> {
  const paths = new Map<string, Map<string, number>>();
  const walk = (n: TreeNode): [string, number][] => {
    if (!n.children) return [[n.name!, n.length]];
    const per = n.children.map(walk);
    per.forEach((a, i) => per.forEach((b, j) => { if (i < j) for (const [x, dx] of a) for (const [y, dy] of b) { const m = paths.get(x) ?? new Map(); m.set(y, dx + dy); paths.set(x, m); const m2 = paths.get(y) ?? new Map(); m2.set(x, dx + dy); paths.set(y, m2); } }));
    return per.flat().map(([name, d]) => [name, d + n.length] as [string, number]);
  };
  walk({ ...t, length: 0 });
  return paths;
}

test('neighbor-joining recovers an additive tree exactly; UPGMA recovers an ultrametric one', () => {
  // tree ((A:1,B:2):1,(C:3,D:4):0)  =>  d(A,B)=3  d(A,C)=1+1+3  d(A,D)=1+1+4 ...
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const T = { A: { B: 3, C: 6, D: 7, E: 10 }, B: { C: 7, D: 8, E: 11 }, C: { D: 7, E: 10 }, D: { E: 11 } } as Record<string, Record<string, number>>;
  // five-leaf additive matrix from ((A:1,B:2):1,C:3,(D:3,E:4):2)  (A-C = 1+1+3 = 5 etc.) – build it from the tree itself
  const edges: Record<string, number> = { A: 1, B: 2, C: 3, D: 3, E: 4 };
  const inner: Record<string, number> = { A: 1, B: 1, C: 0, D: 2, E: 2 }; // distance from each leaf's parent to the central node
  const D = labels.map((x) => labels.map((y) => (x === y ? 0 : (x < y ? 1 : 1) * (edges[x] + edges[y] + (['A', 'B'].includes(x) && ['A', 'B'].includes(y) ? -inner[x] - inner[y] : ['D', 'E'].includes(x) && ['D', 'E'].includes(y) ? -inner[x] - inner[y] : inner[x] + inner[y])))));
  void T;
  const nj = neighborJoining(labels, D);
  const paths = leafPaths(nj);
  for (const x of labels) for (const y of labels) if (x !== y) assert.ok(Math.abs(paths.get(x)!.get(y)! - D[labels.indexOf(x)][labels.indexOf(y)]) < 1e-9, `NJ path ${x}-${y}`);
  const U = [[0, 2, 6, 6], [2, 0, 6, 6], [6, 6, 0, 4], [6, 6, 4, 0]];
  const up = upgma(['a', 'b', 'c', 'd'], U);
  const pu = leafPaths(up);
  assert.ok(Math.abs(pu.get('a')!.get('b')! - 2) < 1e-9 && Math.abs(pu.get('c')!.get('d')! - 4) < 1e-9 && Math.abs(pu.get('a')!.get('c')! - 6) < 1e-9);
  assert.match(newick(up), /^\(.*\);$/);
  assert.ok(['a', 'b', 'c', 'd'].every((n) => newick(up).includes(n)));
  assert.throws(() => neighborJoining(['a', 'b'], [[0, 1], [1, 0]]), /at least 3/);
  assert.equal(jcDistance('ACGT', 'ACGT', 'dna'), 0);
  assert.ok(jcDistance('AAAA', 'CCCC', 'dna') >= 3 - 1e-9, 'saturated distances are capped, not NaN');
  assert.ok(clusterOrder([[0, 0], [10, 10], [0.1, 0.1], [10.1, 9.9]]).join() !== '');
});

// -------- full analyses through compute() --------
const seqInput = (n = 5, len = 120, seed = 3): AnalysisInput => {
  const r = rng(seed); const root = randSeq(r, len, 'ACGT');
  return { seqType: 'dna', sequences: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, label: `seq${i + 1}`, seq: i ? mutate(r, root, 'ACGT', 0.08 * i) : root })) };
};
const matInput = (): AnalysisInput => {
  const r = rng(11); const rows = 12;
  const values = Array.from({ length: rows }, (_, i) => [(i < 6 ? 1 : 5) + r(), (i < 6 ? 2 : 8) + r(), r() * 3, i === 3 ? null : (i < 6 ? 10 : 20) + r()]);
  return { matrix: { rowIds: values.map((_, i) => `r${i}`), rowLabels: values.map((_, i) => `sample${i + 1}`), colNames: ['expr A', 'expr B', 'noise', 'expr C'], colIds: ['a', 'b', 'c', 'd'], values, groups: values.map((_, i) => (i < 6 ? 'control' : 'treated')), groupName: 'Condition' } };
};

test('compute(): every analysis type returns a well-formed result', () => {
  const al = compute('alignment', { ...seqInput(2) }, {});
  assert.equal(al.kind, 'pairwise'); assert.ok(al.alignment.identityPct > 50);
  const ms = compute('alignment', seqInput(5), { mode: 'msa' });
  assert.equal(ms.kind, 'msa'); assert.equal(ms.rows.length, 5);
  const cmp = compute('comparison', seqInput(6), {});
  assert.equal(cmp.method, 'alignment'); assert.equal(cmp.matrix[0][0], 1); assert.ok(cmp.matrix[0][1] > 0.6); assert.equal(cmp.matrix[1][2], cmp.matrix[2][1]);
  const km = compute('comparison', seqInput(6), { method: 'kmer', k: 4 });
  assert.equal(km.method, 'kmer'); assert.ok(km.matrix[0][1] > 0.3);
  const ph = compute('phylogeny', seqInput(5), {});
  assert.equal(ph.method, 'nj'); assert.match(ph.newick, /seq1/); assert.equal(ph.distanceMatrix.length, 5);
  assert.equal(compute('phylogeny', seqInput(5), { method: 'upgma' }).method, 'upgma');
  const hm = compute('heatmap', matInput(), { scale: 'column' });
  assert.equal(hm.rowOrder.length, 12); assert.equal(new Set(hm.rowOrder).size, 12); assert.equal(hm.values[3][3], null, 'missing stays missing');
  assert.ok(Math.abs(hm.values.reduce((s: number, r: (number | null)[]) => s + (r[0] ?? 0), 0)) < 0.05, 'column z-scores sum to ~0');
  const pc = compute('pca', matInput(), {});
  assert.ok(pc.explained[0] > 0.4); assert.equal(pc.scores.length, 12);
  assert.ok(pc.scores.slice(0, 6).every((s: number[]) => Math.sign(s[0]) === Math.sign(pc.scores[0][0])) && pc.scores.slice(6).every((s: number[]) => Math.sign(s[0]) === -Math.sign(pc.scores[0][0])), 'PC1 separates the two groups');
  const st = compute('statistics', matInput(), {});
  assert.equal(st.summary.length, 4); assert.equal(st.summary[3].missing, 1);
  const a = st.groupTest.results[0], noise = st.groupTest.results[2];
  assert.ok(a.p < 1e-6 && noise.p > 0.01, `group test separates signal (p=${a.p}) from noise (p=${noise.p})`);
  assert.throws(() => compute('alignment', seqInput(1), {}), /at least 2/);
  assert.throws(() => compute('pca', { matrix: { ...matInput().matrix!, values: [[1, 2], [3, 4]], colNames: ['a', 'b'], rowLabels: ['x', 'y'], rowIds: ['x', 'y'], colIds: ['a', 'b'] } }, {}), /3 rows/);
});

// -------- export-to-code: executed for real where an interpreter exists --------
const pyOk = spawnSync('python', ['-c', 'import Bio, scipy, pandas, numpy, matplotlib'], { encoding: 'utf8' }).status === 0;
const spec = (type: any, input: AnalysisInput, params: any): CodeSpec => ({ type, name: `Test ${type}`, params, input, result: compute(type, input, params), createdAt: '2026-11-05T00:00:00Z' });
const runPy = (code: string) => {
  const d = mkdtempSync(join(tmpdir(), 'vs-code-')); writeFileSync(join(d, 'script.py'), code);
  return spawnSync('python', ['script.py'], { cwd: d, encoding: 'utf8', env: { ...process.env, MPLBACKEND: 'Agg', PYTHONIOENCODING: 'utf8' } });
};

test('generated scripts embed the exact inputs and parameters (Python, R, Julia)', () => {
  const si = seqInput(3);
  for (const lang of ['python', 'r', 'julia'] as const) {
    const code = generateCode(lang, spec('alignment', si, { mode: 'msa', gapOpen: 6, gapExtend: 3 }));
    for (const s of si.sequences!) { assert.ok(code.includes(s.seq), `${lang}: sequence ${s.label} embedded`); assert.ok(code.includes(s.label)); }
    assert.ok(/gapOpen|open_gap_score|gapOpening|gap_open/.test(code));
    assert.match(code, /VierStation analysis export/); assert.match(code, /"gapOpen":6/);
  }
  const mi = matInput();
  for (const lang of ['python', 'r', 'julia'] as const) {
    const code = generateCode(lang, spec('pca', mi, { scale: false }));
    assert.ok(code.includes('expr A') && code.includes('sample12'));
    assert.ok(/SCALE = False|scale\. = FALSE|\.- mean/.test(code) || code.includes('M .- mean(M, dims = 1)'), `${lang}: scale=false honoured`);
  }
  assert.match(generateCode('python', spec('pca', mi, { scale: true })), /SCALE = True/);
  assert.match(generateCode('r', spec('statistics', mi, { correlation: 'spearman' })), /method = "spearman"/);
  assert.ok(generateCode('r', spec('alignment', seqInput(2), { mode: 'local', gapOpen: 7, gapExtend: 2 })).includes('gapOpening = 5, gapExtension = 2'), 'R gap model converted (open − extend)');
});

test('Python exports run and reproduce the numbers computed by VierStation', { skip: !pyOk && 'python with biopython/scipy/pandas/numpy/matplotlib not installed' }, () => {
  // pairwise alignment score (DNA, with affine gaps)
  const si = seqInput(2, 90, 5);
  const s1 = spec('alignment', si, {});
  const out1 = runPy(generateCode('python', s1));
  assert.equal(out1.status, 0, out1.stderr);
  const m1 = /Score: ([\d.-]+)/.exec(out1.stdout)!;
  assert.ok(Math.abs(Number(m1[1]) - s1.result.alignment.score) < 1e-9, `Biopython ${m1[1]} vs VierStation ${s1.result.alignment.score}`);
  // protein local
  const pr = { seqType: 'protein' as const, sequences: [{ id: 'a', label: 'a', seq: 'HEAGAWGHEE' }, { id: 'b', label: 'b', seq: 'PAWHEAE' }] };
  const s2 = spec('alignment', pr, { mode: 'local' });
  const out2 = runPy(generateCode('python', s2));
  assert.equal(out2.status, 0, out2.stderr);
  assert.ok(Math.abs(Number(/Score: ([\d.-]+)/.exec(out2.stdout)![1]) - s2.result.alignment.score) < 1e-9);
  // MSA script runs and returns rows that recover the inputs
  const s3 = spec('alignment', seqInput(4, 80, 9), { mode: 'msa' });
  const out3 = runPy(generateCode('python', s3));
  assert.equal(out3.status, 0, out3.stderr);
  for (const s of s3.input.sequences!) { const row = out3.stdout.split('\n').find((l) => l.startsWith(s.label))!; assert.equal(row.slice(s.label.length).trim().replace(/-/g, ''), s.seq); }
  // PCA explained variance
  const s4 = spec('pca', matInput(), {});
  const out4 = runPy(generateCode('python', s4));
  assert.equal(out4.status, 0, out4.stderr);
  const ev = /Explained variance ratio: \[([^\]]+)\]/.exec(out4.stdout)![1].trim().split(/\s+/).map(Number);
  assert.ok(Math.abs(ev[0] - s4.result.explained[0]) < 2e-4, `${ev[0]} vs ${s4.result.explained[0]}`);
  // statistics: Welch p-value for the first column
  const s5 = spec('statistics', matInput(), {});
  const out5 = runPy(generateCode('python', s5));
  assert.equal(out5.status, 0, out5.stderr);
  const pv = Number(/expr A: t=[-\d.]+ p=([\d.e-]+)/.exec(out5.stdout)![1]);
  assert.ok(Math.abs(Math.log10(pv) - Math.log10(s5.result.groupTest.results[0].p)) < 0.01, `p ${pv} vs ${s5.result.groupTest.results[0].p}`);
  // phylogeny, comparison (alignment + kmer) and heatmap just have to run cleanly
  for (const [t, inp, prm] of [['phylogeny', seqInput(5, 100, 2), {}], ['phylogeny', seqInput(5, 100, 2), { method: 'upgma' }], ['comparison', seqInput(4, 80, 4), {}], ['comparison', seqInput(4, 80, 4), { method: 'kmer', k: 4 }], ['heatmap', matInput(), { scale: 'row' }]] as const) {
    const o = runPy(generateCode('python', spec(t, inp, prm)));
    assert.equal(o.status, 0, `${t} ${JSON.stringify(prm)}: ${o.stderr}`);
  }
});
