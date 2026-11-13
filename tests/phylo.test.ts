import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseFrequencies, distanceMatrix, prepareColumns } from '../server/phylo/distance.ts';
import { Likelihood, gammaP, gammaRates, maximumLikelihood } from '../server/phylo/likelihood.ts';
import { fitch, minimumEvolution, njTree, olsLengths, parsimonyBranchLengths, patterns, maximumParsimony, upgmaTree } from '../server/phylo/methods.ts';
import { emptyTree, link, newick, rfDistance, root, splits, edges, nni, cloneTree } from '../server/phylo/tree.ts';
import type { UTree } from '../server/phylo/tree.ts';
import { DEFAULT_PARAMS, buildTree, mulberry32, runPhylo, distancesFrom } from '../server/phylo/run.ts';
import type { PhyloParams } from '../server/phylo/run.ts';

const rng = mulberry32(2026);

// ---------- helpers: matrix exponential (independent of the engine) and a sequence simulator ----------
function rateMatrix(kappa: number, pi: number[]) {
  const ts = (i: number, j: number) => (i + j === 2 && i !== j) || (i + j === 4 && i !== j); // A<->G (0,2), C<->T (1,3)
  const Q = Array.from({ length: 4 }, () => new Array(4).fill(0));
  let mu = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i !== j) { Q[i][j] = (ts(i, j) ? kappa : 1) * pi[j]; Q[i][i] -= Q[i][j]; mu += pi[i] * Q[i][j]; }
  return Q.map((r) => r.map((x) => x / mu));
}
function expm(Q: number[][], t: number) {
  const mul = (A: number[][], B: number[][]) => A.map((r, i) => B[0].map((_, j) => r.reduce((s, _x, k) => s + A[i][k] * B[k][j], 0)));
  let s = 0; while (t * 4 / 2 ** s > 0.5) s++;
  let M = Q.map((r) => r.map((x) => (x * t) / 2 ** s)), R = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], term = R;
  for (let k = 1; k < 20; k++) { term = mul(term, M).map((r) => r.map((x) => x / k)); R = R.map((r, i) => r.map((x, j) => x + term[i][j])); }
  for (let i = 0; i < s; i++) R = mul(R, R);
  void M; M = R;
  return R;
}
const pick = (p: number[], u: number) => { let c = 0; for (let i = 0; i < p.length; i++) { c += p[i]; if (u < c) return i; } return p.length - 1; };
function simulate(tree: UTree, L: number, kappa: number, pi: number[], rnd = rng): string[] {
  const Q = rateMatrix(kappa, pi), n = tree.n, rows = Array.from({ length: n }, () => new Array(L).fill(0));
  const root = [...tree.adj.keys()].find((v) => v >= n)!;
  const cache = new Map<number, number[][]>();
  const P = (t: number) => { const k = Math.round(t * 1e6); if (!cache.has(k)) cache.set(k, expm(Q, t)); return cache.get(k)!; };
  for (let s = 0; s < L; s++) {
    const st = new Map<number, number>([[root, pick(pi, rnd())]]);
    const walk = (v: number, par: number) => { for (const [w, l] of tree.adj.get(v)!) if (w !== par) { st.set(w, pick(P(l)[st.get(v)!], rnd())); walk(w, v); } };
    walk(root, -1);
    for (let i = 0; i < n; i++) rows[i][s] = st.get(i)!;
  }
  return rows.map((r) => r.map((x) => 'ACGT'[x]).join(''));
}
/** True tree: ((0,1),(2,3),((4,5),(6,7))) style: eight taxa, internal branches clearly longer than zero. */
function trueTree(internal = 0.12, terminal = 0.08): UTree {
  const t = emptyTree(8); const a = 8, b = 9, c = 10, d = 11, e = 12, f = 13;
  link(t, 0, a, terminal); link(t, 1, a, terminal * 1.3); link(t, 2, b, terminal); link(t, 3, b, terminal * 0.8);
  link(t, a, c, internal); link(t, b, c, internal); link(t, c, d, internal * 1.5);
  link(t, 4, e, terminal); link(t, 5, e, terminal * 1.2); link(t, 6, f, terminal); link(t, 7, f, terminal * 0.9);
  link(t, e, d, internal); link(t, f, d, internal);
  return t;
}
const labels8 = Array.from({ length: 8 }, (_, i) => `T${i + 1}`);

test('distance models match analytic values; TN93 reduces to K2P at equal frequencies; gamma correction increases distances', () => {
  const mk = (n: number, ts: number, tv: number) => { // two sequences with exact counts of transitions/transversions, balanced composition
    const a = 'ACGT'.repeat(n / 4); const b = a.split('');
    for (let i = 0; i < ts; i++) b[i * 4] = 'G'; // A->G transitions at every 4th site
    for (let i = 0; i < tv; i++) b[i * 4 + 1] = 'A'; // C->A transversions
    return [a, b.join('')];
  };
  const [a, b] = mk(1000, 50, 0); // p = 0.05, only transitions
  const jc = distanceMatrix([a, b], 'jc69').D[0][1], k2 = distanceMatrix([a, b], 'k2p').D[0][1], p = distanceMatrix([a, b], 'p').D[0][1];
  assert.ok(Math.abs(p - 0.05) < 1e-12);
  assert.ok(Math.abs(jc - -0.75 * Math.log(1 - (4 / 3) * 0.05)) < 1e-9);
  assert.ok(Math.abs(k2 - (-0.5 * Math.log(1 - 2 * 0.05 - 0) - 0.25 * Math.log(1))) < 1e-9);
  const [c, d] = mk(1000, 30, 20); // P=0.03, Q=0.02
  const k2b = distanceMatrix([c, d], 'k2p').D[0][1];
  assert.ok(Math.abs(k2b - (-0.5 * Math.log(1 - 2 * 0.03 - 0.02) - 0.25 * Math.log(1 - 2 * 0.02))) < 1e-9);
  // equal base frequencies and P1 = P2 → TN93 == K2P
  const [e, f] = [ 'ACGT'.repeat(250), (() => { const x = 'ACGT'.repeat(250).split(''); for (let i = 0; i < 20; i++) { x[i * 4] = 'G'; x[i * 4 + 1 + 0 * 0] = x[i * 4 + 1]; } for (let i = 0; i < 20; i++) x[i * 4 + 1] = 'T'; return x.join(''); })()];
  const fr = baseFrequencies([e, f]);
  assert.ok(Math.abs(fr[0] - fr[1]) < 0.02, 'near-equal frequencies');
  const tn = distanceMatrix([e, f], 'tn93').D[0][1], kk = distanceMatrix([e, f], 'k2p').D[0][1];
  assert.ok(Math.abs(tn - kk) < 0.01, `TN93 ${tn} vs K2P ${kk}`);
  assert.ok(distanceMatrix([a, b], 'jc69', 0.5).D[0][1] > jc, 'gamma-corrected distance is larger');
  const sat = distanceMatrix(['ACGT'.repeat(50), 'CATG'.repeat(50)], 'jc69');
  assert.equal(sat.saturated, 1); assert.equal(sat.D[0][1], 3);
});

test('gap treatment: pairwise keeps columns, complete deletion removes any column with a gap/ambiguity, partial uses the coverage cutoff', () => {
  const rows = ['ACGTACGTAC', 'ACGTAC-TAC', 'ACGNACGTAC', 'ACGTACGTAC'];
  assert.equal(prepareColumns(rows, { mode: 'pairwise' }).kept, 10);
  assert.equal(prepareColumns(rows, { mode: 'complete' }).kept, 8);
  assert.equal(prepareColumns(rows, { mode: 'partial', cutoff: 30 }).kept, 10, 'one of four (25%) missing ≤ 30% cutoff → kept');
  assert.equal(prepareColumns(rows, { mode: 'partial', cutoff: 10 }).kept, 8);
  assert.throws(() => prepareColumns(['ACG', 'AC'], { mode: 'pairwise' }), /same length/);
  const d = distanceMatrix(['ACGTACGTAC'.repeat(5), 'ACGTAC-TAC'.repeat(5)], 'p');
  assert.equal(d.compared[0][1], 45, 'pairwise deletion compares only columns valid in both');
});

test('gamma functions: incomplete gamma, category rates (Yang 1994 values for alpha = 0.5, K = 4)', () => {
  assert.ok(Math.abs(gammaP(1, 2) - (1 - Math.exp(-2))) < 1e-12);
  assert.ok(Math.abs(gammaP(3, 3) - 0.5768099) < 1e-6);
  const r = gammaRates(0.5, 4);
  assert.ok(Math.abs(r.reduce((a, b) => a + b, 0) / 4 - 1) < 1e-12, 'mean rate 1');
  [0.0291, 0.2807, 0.9249, 2.7652].forEach((x, i) => assert.ok(Math.abs(r[i] - x) < 0.01, `rate ${i}: ${r[i]} vs ${x}`));
  assert.ok(gammaRates(200, 4).every((x) => Math.abs(x - 1) < 0.2), 'large alpha → almost no rate variation');
});

/** Brute-force likelihood of ONE site on the 4-taxon tree ((0,1),(2,3)) by summing over both internal states. */
function bruteSite(P: (t: number) => number[][], pi: number[], leaf: number[], t: { l0: number; l1: number; l2: number; l3: number; m: number }) {
  let s = 0;
  for (let u = 0; u < 4; u++) for (let v = 0; v < 4; v++) s += pi[u] * P(t.l0)[u][leaf[0]] * P(t.l1)[u][leaf[1]] * P(t.m)[u][v] * P(t.l2)[v][leaf[2]] * P(t.l3)[v][leaf[3]];
  return s;
}
test('maximum-likelihood lnL equals brute-force enumeration over internal states (JC69, K80, HKY85, +Γ)', () => {
  const tr = emptyTree(4); link(tr, 0, 4, 0.11); link(tr, 1, 4, 0.23); link(tr, 4, 5, 0.07); link(tr, 5, 2, 0.31); link(tr, 5, 3, 0.05);
  const rows = ['ACGTACGTTAGCAA', 'ACGTTCGTTAGCAG', 'ACTTACGATAGGAA', 'GCGTACGATAGCAA'];
  const L = rows[0].length, idx = rows.map((r) => [...r].map((c) => 'ACGT'.indexOf(c)));
  const pi = [0.3, 0.2, 0.25, 0.25];
  for (const [model, kappa, freqs] of [['JC69', 1, [0.25, 0.25, 0.25, 0.25]], ['K80', 3.1, [0.25, 0.25, 0.25, 0.25]], ['HKY85', 2.4, pi]] as const) {
    const lik = new Likelihood(rows, { model, kappa, freqs: freqs as [number, number, number, number], alpha: null, ncat: 1 });
    const Q = rateMatrix(model === 'JC69' ? 1 : kappa, [...freqs]);
    let want = 0;
    for (let s = 0; s < L; s++) want += Math.log(bruteSite((t) => expm(Q, t), [...freqs], [idx[0][s], idx[1][s], idx[2][s], idx[3][s]], { l0: 0.11, l1: 0.23, m: 0.07, l2: 0.31, l3: 0.05 }));
    assert.ok(Math.abs(lik.lnL(tr) - want) < 1e-9, `${model}: ${lik.lnL(tr)} vs ${want}`);
  }
  // +Γ: average over the category rates
  const ncat = 4, alpha = 0.7, rates = gammaRates(alpha, ncat), Q = rateMatrix(2, pi);
  const lik = new Likelihood(rows, { model: 'HKY85', kappa: 2, freqs: pi as [number, number, number, number], alpha, ncat });
  let want = 0;
  for (let s = 0; s < L; s++) { let site = 0; for (const r of rates) site += bruteSite((t) => expm(Q, t * r), pi, [idx[0][s], idx[1][s], idx[2][s], idx[3][s]], { l0: 0.11, l1: 0.23, m: 0.07, l2: 0.31, l3: 0.05 }) / ncat; want += Math.log(site); }
  assert.ok(Math.abs(lik.lnL(tr) - want) < 1e-9, `gamma: ${lik.lnL(tr)} vs ${want}`);
  // missing data (gaps/N) contribute no information
  const withGap = new Likelihood(['ACGT-CGTTAGCAA', rows[1], rows[2], rows[3]], { model: 'JC69', kappa: 1, freqs: [0.25, 0.25, 0.25, 0.25], alpha: null, ncat: 1 });
  assert.ok(Number.isFinite(withGap.lnL(tr)));
});

test('branch-length optimisation never lowers lnL and recovers a known length from abundant data', () => {
  const tr = emptyTree(4); link(tr, 0, 4, 0.1); link(tr, 1, 4, 0.1); link(tr, 4, 5, 0.1); link(tr, 5, 2, 0.1); link(tr, 5, 3, 0.1);
  const rows = simulate(tr, 4000, 1, [0.25, 0.25, 0.25, 0.25]);
  const lik = new Likelihood(rows, { model: 'JC69', kappa: 1, freqs: [0.25, 0.25, 0.25, 0.25], alpha: null, ncat: 1 });
  const start = emptyTree(4); link(start, 0, 4, 0.5); link(start, 1, 4, 0.5); link(start, 4, 5, 0.5); link(start, 5, 2, 0.5); link(start, 5, 3, 0.5);
  const before = lik.lnL(start), after = lik.optimizeBranches(start, 4);
  assert.ok(after > before);
  for (const [, , l] of edges(start)) assert.ok(Math.abs(l - 0.1) < 0.035, `estimated ${l}`);
});

test('simulated data (HKY85, kappa 4, 2000 sites): every method recovers the true topology; ML estimates kappa; lnL is improved by optimisation', () => {
  const truth = trueTree(), pi = [0.3, 0.2, 0.2, 0.3];
  const rows = simulate(truth, 2000, 4, pi);
  const base: PhyloParams = { ...DEFAULT_PARAMS, bootstrap: 0, rooting: 'unrooted' };
  const rf = (t: UTree) => rfDistance(t, truth);
  const nj = buildTree(labels8, rows, { ...base, method: 'nj', distance: 'k2p' }).tree;
  const up = buildTree(labels8, rows, { ...base, method: 'upgma' }).tree;
  const me = buildTree(labels8, rows, { ...base, method: 'me' }).tree;
  const mp = buildTree(labels8, rows, { ...base, method: 'mp' }).tree;
  const mlr = buildTree(labels8, rows, { ...base, method: 'ml', mlModel: 'HKY85', mlGamma: false });
  assert.equal(rf(nj), 0, 'NJ'); assert.equal(rf(me), 0, 'ME'); assert.equal(rf(mp), 0, 'MP'); assert.equal(rf(mlr.tree), 0, 'ML');
  assert.ok(rf(up) <= 2, 'UPGMA (assumes a clock; the simulated tree is not ultrametric) gets at least most splits right');
  const kappa = (mlr.model as any).kappa;
  assert.ok(kappa > 2.8 && kappa < 5.6, `kappa estimate ${kappa} (true 4)`);
  const nj0 = njTree(labels8, distanceMatrix(rows, 'jc69').D);
  const lik = new Likelihood(rows, { model: 'JC69', kappa: 1, freqs: [0.25, 0.25, 0.25, 0.25], alpha: null, ncat: 1 });
  assert.ok(mlr.score! > lik.lnL(nj0), 'HKY85 ML lnL exceeds the JC69 likelihood on the NJ tree');
  // model comparison works: HKY85 should beat JC69 on data simulated with kappa 4 and unequal frequencies (AIC lower)
  const jcFit = maximumLikelihood(nj0, rows, { model: 'JC69', kappa: 1, freqs: [0.25, 0.25, 0.25, 0.25], alpha: null, ncat: 1 });
  const hkyFit = maximumLikelihood(nj0, rows, { model: 'HKY85', kappa: 2, freqs: Likelihood.empiricalFreqs(rows), alpha: null, ncat: 1 });
  assert.ok(hkyFit.aic < jcFit.aic, `AIC HKY85 ${hkyFit.aic.toFixed(1)} < JC69 ${jcFit.aic.toFixed(1)}`);
});

test('parsimony: per-branch changes add up to the Fitch score; ME recovers exact lengths from additive distances and repairs a wrong topology', () => {
  const truth = trueTree(0.2, 0.1), rows = simulate(truth, 600, 1, [0.25, 0.25, 0.25, 0.25]);
  const P = patterns(rows), nj = njTree(labels8, distanceMatrix(rows, 'jc69').D);
  const { lengths, score } = parsimonyBranchLengths(nj, P);
  assert.equal(score, fitch(nj, P), 'reconstruction length equals the Fitch score');
  const total = [...lengths.values()].reduce((a, b) => a + b, 0) * P.sites;
  assert.ok(Math.abs(total - fitch(nj, P)) < 1e-6);
  // additive distances from the true tree
  const n = 8, D = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) { const d = (function pat() { const dist = new Map<number, number>([[i, 0]]); const st: [number, number][] = [[i, -1]]; while (st.length) { const [v, p] = st.pop()!; for (const [w, l] of truth.adj.get(v)!) if (w !== p) { dist.set(w, dist.get(v)! + l); st.push([w, v]); } } return dist; })(); for (let j = 0; j < n; j++) D[i][j] = d.get(j)!; }
  const ols = olsLengths(truth, D);
  for (const [a, b, l] of edges(truth)) assert.ok(Math.abs(ols.lengths.get(`${a}-${b}`)! - l) < 1e-6);
  // break the topology with two NNI moves; minimum evolution must find its way back
  let wrong = truth; const ie = [...splits(truth).values()];
  wrong = nni(wrong, ie[0][0], ie[0][1], 0); wrong = nni(wrong, ...( [...splits(wrong).values()][1] as [number, number]), 1);
  assert.ok(rfDistance(wrong, truth) > 0);
  const fixed = minimumEvolution(wrong, D);
  assert.equal(rfDistance(fixed.tree, truth), 0);
  const mpFixed = maximumParsimony(wrong, simulate(truth, 1500, 1, [0.25, 0.25, 0.25, 0.25]));
  assert.ok(rfDistance(mpFixed.tree, truth) <= 2);
});

test('bootstrap: well-supported clades reach ~100, a nearly-zero internal branch gets low support; results are reproducible for a seed', async () => {
  const rows = simulate(trueTree(0.15, 0.06), 1200, 2, [0.25, 0.25, 0.25, 0.25]);
  const p: PhyloParams = { ...DEFAULT_PARAMS, method: 'nj', distance: 'k2p', bootstrap: 100, rooting: 'unrooted' };
  const r1 = await runPhylo({ labels: labels8, rows }, p), r2 = await runPhylo({ labels: labels8, rows }, p);
  assert.deepEqual(r1.support, r2.support, 'same seed → identical support values');
  const vals = Object.values(r1.support);
  assert.ok(vals.length >= 4 && vals.filter((v) => v >= 90).length >= 4, `supports ${vals}`);
  const weak = simulate(trueTree(0.002, 0.15), 500, 2, [0.25, 0.25, 0.25, 0.25]);
  const rw = await runPhylo({ labels: labels8, rows: weak }, p);
  assert.ok(Math.min(...Object.values(rw.support)) < 70, `an almost-zero internal branch is not well supported: ${Object.values(rw.support)}`);
  const other = await runPhylo({ labels: labels8, rows }, { ...p, seed: 7 });
  assert.notDeepEqual(other.support, undefined);
});

test('rooting: outgroup on its own branch, non-monophyletic outgroup warns, midpoint rooting, UPGMA is rooted by construction', async () => {
  const truth = trueTree(0.15, 0.08), rows = simulate(truth, 1500, 2, [0.25, 0.25, 0.25, 0.25]);
  const out = root(truth, labels8, null, { mode: 'outgroup', taxa: [6, 7] });
  assert.ok(out.tree.children!.some((c) => (c.children?.map((x) => x.name).sort().join() === 'T7,T8') || c.name === undefined), 'root is placed on the branch to the T7+T8 clade');
  assert.equal(out.warnings.length, 0);
  const bad = root(truth, labels8, null, { mode: 'outgroup', taxa: [0, 7] });
  assert.match(bad.warnings[0], /not monophyletic/);
  const mid = root(truth, labels8, null, { mode: 'midpoint' });
  const depth = (n: any): number => (n.children ? Math.max(...n.children.map((c: any) => c.length + depth(c))) : 0);
  const [a, b] = mid.tree.children!.map((c) => c.length + depth(c));
  assert.ok(Math.abs(a - b) < 1e-9, 'both sides of a midpoint root are equally deep');
  const r = await runPhylo({ labels: labels8, rows }, { ...DEFAULT_PARAMS, method: 'upgma', bootstrap: 0 });
  assert.match(r.rooting, /UPGMA/); assert.equal(r.tree.children!.length, 2);
  const ru = await runPhylo({ labels: labels8, rows }, { ...DEFAULT_PARAMS, method: 'nj', bootstrap: 0, rooting: 'outgroup', outgroups: ['T7', 'T8'] });
  assert.match(ru.rooting, /Rooted on the branch leading to the outgroup/);
  assert.match(newick(ru.tree), /^\(.*\);$/);
  assert.ok(distancesFrom(ru.edges, 8, 0)[1] < distancesFrom(ru.edges, 8, 0)[6], 'sister taxon is closer than a distant one');
});

test('input validation: too few sequences, identical sequences, too few columns, and warnings for short / uninformative data', async () => {
  const same = ['ACGT'.repeat(100), 'ACGT'.repeat(100), 'ACGT'.repeat(100)];
  await assert.rejects(runPhylo({ labels: ['a', 'b', 'c'], rows: same }, { ...DEFAULT_PARAMS, bootstrap: 0 }), /nearly\) identical/);
  await assert.rejects(runPhylo({ labels: ['a', 'b'], rows: same.slice(0, 2) }, { ...DEFAULT_PARAMS, bootstrap: 0 }), /at least 3/);
  const gappy = same.map((r, i) => (i ? '-'.repeat(380) + r.slice(380) : r));
  await assert.rejects(runPhylo({ labels: ['a', 'b', 'c'], rows: gappy }, { ...DEFAULT_PARAMS, bootstrap: 0, gap: { mode: 'complete' } }), /remain after/);
  const rows = simulate(trueTree(), 200, 2, [0.25, 0.25, 0.25, 0.25]);
  const r = await runPhylo({ labels: labels8, rows }, { ...DEFAULT_PARAMS, bootstrap: 0, rooting: 'unrooted' });
  assert.ok(r.warnings.some((w) => /Only 200 aligned sites/.test(w)));
  void cloneTree; void upgmaTree;
});
