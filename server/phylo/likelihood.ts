// Maximum Likelihood for nucleotide alignments: Felsenstein pruning, models JC69 / K80 / F81 / HKY85, optional discrete-Γ rate variation
// (Yang 1994, median method), branch-length and parameter optimisation, NNI topology search.
import { jacobiEigen } from '../analysis/stats.ts';
import { cloneTree, edges, internalEdges, link, nni } from './tree.ts';
import type { UTree } from './tree.ts';
import { patterns } from './methods.ts';
import type { Patterns } from './methods.ts';

export type MLModelName = 'JC69' | 'K80' | 'F81' | 'HKY85';
export interface MLParams { model: MLModelName; kappa: number; freqs: [number, number, number, number]; alpha: number | null; ncat: number }

// ---- gamma rate categories ----
function lgam(z: number): number { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = z, x = z; let t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const cj of c) s += cj / ++y; return -t + Math.log((2.5066282746310005 * s) / x); }
/** Regularised lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) { let sum = 1 / a, del = sum, ap = a; for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; } return sum * Math.exp(-x + a * Math.log(x) - lgam(a)); }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) { const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break; }
  return 1 - Math.exp(-x + a * Math.log(x) - lgam(a)) * h;
}
function gammaQuantile(a: number, p: number): number { let lo = 0, hi = 1; while (gammaP(a, hi) < p) hi *= 2; for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (gammaP(a, mid) < p) lo = mid; else hi = mid; } return (lo + hi) / 2; }
/** K equal-probability categories of Gamma(α, α) (mean 1), represented by their medians and rescaled to mean exactly 1. */
export function gammaRates(alpha: number, K: number): number[] {
  const r = Array.from({ length: K }, (_, k) => gammaQuantile(alpha, (2 * k + 1) / (2 * K)) / alpha);
  const m = r.reduce((a, b) => a + b, 0) / K;
  return r.map((x) => x / m);
}

// ---- substitution model ----
class Model {
  p: MLParams; rates: number[]; U: number[][] = []; lam: number[] = []; sq: number[] = [];
  constructor(p: MLParams) {
    this.p = p;
    this.rates = p.alpha && p.ncat > 1 ? gammaRates(p.alpha, p.ncat) : [1];
    const pi = p.model === 'JC69' || p.model === 'K80' ? [0.25, 0.25, 0.25, 0.25] : p.freqs;
    const k = p.model === 'JC69' || p.model === 'F81' ? 1 : p.kappa;
    const [pA, pC, pG, pT] = pi, pR = pA + pG, pY = pC + pT;
    const beta = 1 / (2 * (k * (pT * pC + pA * pG) + pR * pY));
    const isTs = (i: number, j: number) => (i === 0 && j === 2) || (i === 2 && j === 0) || (i === 1 && j === 3) || (i === 3 && j === 1);
    const S = Array.from({ length: 4 }, () => new Array(4).fill(0));
    for (let i = 0; i < 4; i++) { let row = 0; for (let j = 0; j < 4; j++) if (i !== j) { const q = beta * (isTs(i, j) ? k : 1) * pi[j]; row += q; S[i][j] = Math.sqrt(pi[i] * pi[j]) * beta * (isTs(i, j) ? k : 1); } S[i][i] = -row; }
    const { values, vectors } = jacobiEigen(S);
    this.lam = values; this.U = vectors; this.sq = pi.map(Math.sqrt);
    this.pi = pi as [number, number, number, number];
  }
  pi: [number, number, number, number] = [0.25, 0.25, 0.25, 0.25];
  /** 4×4 transition matrix (row-major) for branch length t. */
  P(t: number, out: Float64Array) {
    const e = this.lam.map((l) => Math.exp(l * t));
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += this.U[i][k] * e[k] * this.U[j][k]; out[i * 4 + j] = Math.max(0, (s * this.sq[j]) / this.sq[i]); }
  }
}

interface Part { L: Float64Array; s: Float64Array }

export class Likelihood {
  data: Patterns; np: number; m!: Model; C = 1; n: number; rows: string[]; params: MLParams;
  constructor(rows: string[], params: MLParams, shared?: Patterns) { this.rows = rows; this.params = params; this.data = shared ?? patterns(rows); this.np = this.data.weights.length; this.n = rows.length; this.setParams(params); }
  setParams(p: MLParams) { this.params = p; this.m = new Model(p); this.C = this.m.rates.length; }
  static empiricalFreqs(rows: string[]): [number, number, number, number] { const f = [0, 0, 0, 0]; let t = 0; for (const r of rows) for (const c of r) { const i = 'ACGT'.indexOf(c); if (i >= 0) { f[i]++; t++; } } return t ? (f.map((x) => x / t) as [number, number, number, number]) : [0.25, 0.25, 0.25, 0.25]; }

  private leaf(i: number): Part {
    const L = new Float64Array(this.np * this.C * 4), codes = this.data.codes[i];
    for (let p = 0; p < this.np; p++) for (let c = 0; c < this.C; c++) for (let s = 0; s < 4; s++) L[(p * this.C + c) * 4 + s] = (codes[p] >> s) & 1;
    return { L, s: new Float64Array(this.np) };
  }
  /** Conditional likelihoods of the subtree at v (looking away from `parent`). */
  partial(t: UTree, v: number, parent: number): Part {
    if (v < t.n) return this.leaf(v);
    const { np, C } = this, out = new Float64Array(np * C * 4).fill(1), sc = new Float64Array(np), P = new Float64Array(16);
    for (const [w, len] of t.adj.get(v)!) {
      if (w === parent) continue;
      const ch = this.partial(t, w, v);
      for (let p = 0; p < np; p++) sc[p] += ch.s[p];
      for (let c = 0; c < C; c++) {
        this.m.P(len * this.m.rates[c], P);
        for (let p = 0; p < np; p++) { const o = (p * C + c) * 4; for (let i = 0; i < 4; i++) { const k = i * 4; out[o + i] *= P[k] * ch.L[o] + P[k + 1] * ch.L[o + 1] + P[k + 2] * ch.L[o + 2] + P[k + 3] * ch.L[o + 3]; } }
      }
    }
    for (let p = 0; p < np; p++) { let mx = 0; for (let k = p * C * 4; k < (p + 1) * C * 4; k++) if (out[k] > mx) mx = out[k]; if (mx > 0 && mx < 1e-100) { for (let k = p * C * 4; k < (p + 1) * C * 4; k++) out[k] /= mx; sc[p] += Math.log(mx); } }
    return { L: out, s: sc };
  }
  /** lnL for an edge (a,b) carrying length t, given the partials on both sides. */
  edgeLnL(A: Part, B: Part, t: number): number {
    const { np, C } = this, P = new Float64Array(16), pi = this.m.pi, site = new Float64Array(np);
    for (let c = 0; c < C; c++) {
      this.m.P(t * this.m.rates[c], P);
      for (let p = 0; p < np; p++) { const o = (p * C + c) * 4; let s = 0; for (let i = 0; i < 4; i++) { const k = i * 4; s += pi[i] * A.L[o + i] * (P[k] * B.L[o] + P[k + 1] * B.L[o + 1] + P[k + 2] * B.L[o + 2] + P[k + 3] * B.L[o + 3]); } site[p] += s / C; }
    }
    let ll = 0; for (let p = 0; p < np; p++) ll += this.data.weights[p] * (Math.log(Math.max(site[p], 1e-300)) + A.s[p] + B.s[p]);
    return ll;
  }
  lnL(t: UTree): number { const nb = [...t.adj.get(0)!.entries()][0]; return this.edgeLnL(this.leaf(0), this.partial(t, nb[0], 0), nb[1]); }

  /** Optimise one branch length (golden-section on the edge likelihood); mutates the tree. Returns the lnL. */
  optimizeEdge(t: UTree, a: number, b: number): number {
    const A = this.partial(t, a, b), B = this.partial(t, b, a);
    let lo = 1e-8, hi = 4, g = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = this.edgeLnL(A, B, x1), f2 = this.edgeLnL(A, B, x2);
    for (let i = 0; i < 28 && hi - lo > 1e-6; i++) {
      if (f1 > f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = this.edgeLnL(A, B, x1); } else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = this.edgeLnL(A, B, x2); }
    }
    const best = (lo + hi) / 2;
    const f0 = this.edgeLnL(A, B, t.adj.get(a)!.get(b)!), fb = this.edgeLnL(A, B, best);
    if (fb >= f0) { link(t, a, b, best); return fb; }
    return f0;
  }
  optimizeBranches(t: UTree, passes = 2): number {
    let ll = this.lnL(t);
    for (let k = 0; k < passes; k++) { const before = ll; for (const [a, b] of edges(t)) ll = this.optimizeEdge(t, a, b); if (ll - before < 1e-4) break; }
    return ll;
  }
  /** Optimise κ and α (one-dimensional golden searches on the log scale, branch lengths fixed). */
  optimizeParams(t: UTree): number {
    const p0 = this.params; let ll = this.lnL(t);
    const search = (f: (x: number) => number, lo: number, hi: number) => { const g = (Math.sqrt(5) - 1) / 2; let a = Math.log(lo), b = Math.log(hi), x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = f(Math.exp(x1)), f2 = f(Math.exp(x2)); for (let i = 0; i < 18; i++) { if (f1 > f2) { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = f(Math.exp(x1)); } else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = f(Math.exp(x2)); } } return Math.exp((a + b) / 2); };
    if (p0.model === 'K80' || p0.model === 'HKY85') {
      const k = search((x) => { this.setParams({ ...this.params, kappa: x }); return this.lnL(t); }, 0.05, 100);
      this.setParams({ ...this.params, kappa: k });
    }
    if (p0.alpha !== null) {
      const a = search((x) => { this.setParams({ ...this.params, alpha: x }); return this.lnL(t); }, 0.02, 200);
      this.setParams({ ...this.params, alpha: a });
    }
    const after = this.lnL(t);
    if (after < ll - 1e-6) { this.setParams(p0); return ll; } // never accept a worse likelihood
    return after;
  }
  nFreeParams(t: UTree) { return edges(t).length + (this.params.model === 'K80' || this.params.model === 'HKY85' ? 1 : 0) + (this.params.alpha !== null ? 1 : 0) + (this.params.model === 'F81' || this.params.model === 'HKY85' ? 3 : 0); }
}

export interface MLResult { tree: UTree; lnL: number; params: MLParams; aic: number; bic: number; rounds: number; sites: number }

export function maximumLikelihood(start: UTree, rows: string[], model: MLParams, o: { fast?: boolean; maxRounds?: number; onRound?: (r: number, ll: number) => void; isCancelled?: () => boolean; shared?: Patterns } = {}): MLResult {
  const lik = new Likelihood(rows, model.model === 'F81' || model.model === 'HKY85' ? { ...model, freqs: model.freqs } : model, o.shared);
  let tree = cloneTree(start);
  for (const [a, b, l] of edges(tree)) if (!(l > 0)) link(tree, a, b, 0.01);
  let ll = lik.optimizeBranches(tree, o.fast ? 1 : 2);
  if (!o.fast) { for (let k = 0; k < 2; k++) { ll = lik.optimizeParams(tree); ll = lik.optimizeBranches(tree, 1); } }
  let rounds = 0;
  for (let r = 1; r <= (o.maxRounds ?? (o.fast ? 2 : 12)); r++) {
    rounds = r; let improved = false;
    for (const [u, v] of internalEdges(tree)) {
      if (o.isCancelled?.()) throw new Error('Cancelled');
      if (!tree.adj.get(u)?.has(v)) continue;
      for (const variant of [0, 1] as const) {
        const cand = nni(tree, u, v, variant);
        // local re-optimisation: the swapped edge and the four edges touching it
        const loc = new Set<string>([`${u}-${v}`]); for (const x of [u, v]) for (const y of cand.adj.get(x)!.keys()) loc.add(x < y ? `${x}-${y}` : `${y}-${x}`);
        let cl = lik.lnL(cand);
        for (const e of loc) { const [a, b] = e.split('-').map(Number); cl = lik.optimizeEdge(cand, a, b); }
        if (cl > ll + 1e-3) { tree = cand; ll = cl; improved = true; break; }
      }
    }
    o.onRound?.(r, ll);
    if (!improved) break;
    ll = lik.optimizeBranches(tree, 1);
  }
  if (!o.fast) { ll = lik.optimizeParams(tree); ll = lik.optimizeBranches(tree, 3); }
  const k = lik.nFreeParams(tree), sites = lik.data.sites;
  return { tree, lnL: ll, params: lik.params, aic: 2 * k - 2 * ll, bic: Math.log(sites) * k - 2 * ll, rounds, sites };
}
