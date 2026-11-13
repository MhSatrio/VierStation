// Tree-building methods: Neighbor-Joining, UPGMA, Minimum Evolution (OLS + NNI), Maximum Parsimony (Fitch + NNI).
import { neighborJoining, upgma } from '../analysis/stats.ts';
import { cloneTree, edges, fromTreeNode, internalEdges, link, nni, sideOf, treeLength } from './tree.ts';
import type { UTree } from './tree.ts';

export const njTree = (labels: string[], D: number[][]): UTree => fromTreeNode(neighborJoining(labels, D), labels.length);
export const upgmaTree = (labels: string[], D: number[][]): UTree => fromTreeNode(upgma(labels, D), labels.length);

/** Generic first-improvement NNI hill climb (minimise `score`). */
export function hillClimb(start: UTree, score: (t: UTree) => number, o: { maxRounds?: number; eps?: number; onRound?: (round: number, s: number) => void; isCancelled?: () => boolean } = {}) {
  let best = start, bestScore = score(start);
  const eps = o.eps ?? 1e-9;
  for (let round = 1; round <= (o.maxRounds ?? 30); round++) {
    let improved = false;
    for (const [u, v] of internalEdges(best)) {
      if (o.isCancelled?.()) throw new Error('Cancelled');
      if (!best.adj.get(u)?.has(v)) continue;
      for (const variant of [0, 1] as const) {
        const cand = nni(best, u, v, variant), s = score(cand);
        if (s < bestScore - eps) { best = cand; bestScore = s; improved = true; break; }
      }
    }
    o.onRound?.(round, bestScore);
    if (!improved) return { tree: best, score: bestScore, rounds: round };
  }
  return { tree: best, score: bestScore, rounds: o.maxRounds ?? 30 };
}

// ---------------- Minimum Evolution: ordinary least-squares branch lengths, minimise their sum (Rzhetsky & Nei 1992) ----------------
export function olsLengths(t: UTree, D: number[][]): { lengths: Map<string, number>; total: number } {
  const E = edges(t), m = E.length, n = t.n;
  const sides = E.map(([a, b]) => { const s = new Set(sideOf(t, a, b)); return s; });
  const on: number[][] = []; // for pair (i,j): list of edge indices on its path
  const pairD: number[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const p: number[] = []; for (let e = 0; e < m; e++) if (sides[e].has(i) !== sides[e].has(j)) p.push(e); on.push(p); pairD.push(D[i][j]); }
  const A = Array.from({ length: m }, () => new Float64Array(m + 1)); // augmented normal equations
  on.forEach((p, k) => { for (const e of p) { for (const f of p) A[e][f] += 1; A[e][m] += pairD[k]; } });
  for (let e = 0; e < m; e++) A[e][e] += 1e-9;
  for (let c = 0; c < m; c++) { // Gaussian elimination with partial pivoting
    let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c]; if (Math.abs(d) < 1e-12) continue;
    for (let r = c + 1; r < m; r++) { const f = A[r][c] / d; if (f) for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; }
  }
  const b = new Float64Array(m);
  for (let r = m - 1; r >= 0; r--) { let s = A[r][m]; for (let k = r + 1; k < m; k++) s -= A[r][k] * b[k]; b[r] = Math.abs(A[r][r]) < 1e-12 ? 0 : s / A[r][r]; }
  const lengths = new Map<string, number>(); let total = 0;
  E.forEach(([a, c], e) => { lengths.set(`${a}-${c}`, b[e]); total += b[e]; });
  return { lengths, total };
}
export function applyLengths(t: UTree, lengths: Map<string, number>): UTree {
  const r = cloneTree(t);
  for (const [k, v] of lengths) { const [a, b] = k.split('-').map(Number); link(r, a, b, Math.max(0, v)); } // negative OLS lengths are displayed as 0 (they are noise around a true zero)
  return r;
}
export function minimumEvolution(start: UTree, D: number[][], o: Parameters<typeof hillClimb>[2] = {}) {
  const r = hillClimb(start, (t) => olsLengths(t, D).total, o);
  const { lengths, total } = olsLengths(r.tree, D);
  return { tree: applyLengths(r.tree, lengths), score: total, rounds: r.rounds };
}

// ---------------- Maximum Parsimony ----------------
export interface Patterns { codes: Uint8Array[]; weights: number[]; sites: number } // codes[taxon][pattern] bitmask (A=1 C=2 G=4 T=8, ambiguity = union, gap/N = 15)
const BIT: Record<string, number> = { A: 1, C: 2, G: 4, T: 8, R: 5, Y: 10, S: 6, W: 9, K: 12, M: 3, B: 14, D: 13, H: 11, V: 7, N: 15, '-': 15, '?': 15 };
export function patterns(rows: string[]): Patterns {
  const L = rows[0].length, map = new Map<string, number>(), cols: number[][] = [], weights: number[] = [];
  for (let c = 0; c < L; c++) {
    const key = rows.map((r) => r[c]).join('');
    const hit = map.get(key);
    if (hit !== undefined) weights[hit]++; else { map.set(key, cols.length); cols.push(rows.map((r) => BIT[r[c]] ?? 15)); weights.push(1); }
  }
  return { codes: rows.map((_, i) => Uint8Array.from(cols.map((c) => c[i]))), weights, sites: L };
}
const low = (m: number) => m & -m;

/** Fitch parsimony length (weighted over patterns), rooted at the neighbour of taxon 0. */
export function fitch(t: UTree, P: Patterns): number {
  const np = P.weights.length, root = [...t.adj.get(0)!.keys()][0];
  let cost = 0;
  const down = (v: number, par: number): Uint8Array => {
    if (v < t.n) return P.codes[v];
    const kids = [...t.adj.get(v)!.keys()].filter((w) => w !== par).map((w) => down(w, v));
    let cur = kids[0];
    for (let k = 1; k < kids.length; k++) { const nxt = new Uint8Array(np); for (let p = 0; p < np; p++) { const i = cur[p] & kids[k][p]; if (i) nxt[p] = i; else { nxt[p] = cur[p] | kids[k][p]; cost += P.weights[p]; } } cur = nxt; }
    return cur;
  };
  const top = down(root, 0);
  for (let p = 0; p < np; p++) if (!(top[p] & P.codes[0][p])) cost += P.weights[p];
  return cost;
}

/** Changes per branch under one most-parsimonious reconstruction (Fitch down-pass, then top-down state assignment). Sum equals the tree length. */
export function parsimonyBranchLengths(t: UTree, P: Patterns): { lengths: Map<string, number>; score: number } {
  const np = P.weights.length, root = [...t.adj.get(0)!.keys()][0];
  const sets = new Map<number, Uint8Array>();
  const down = (v: number, par: number): Uint8Array => {
    if (v < t.n) { sets.set(v, P.codes[v]); return P.codes[v]; }
    const kids = [...t.adj.get(v)!.keys()].filter((w) => w !== par).map((w) => down(w, v));
    let cur = kids[0];
    for (let k = 1; k < kids.length; k++) { const nxt = new Uint8Array(np); for (let p = 0; p < np; p++) { const i = cur[p] & kids[k][p]; nxt[p] = i || (cur[p] | kids[k][p]); } cur = nxt; }
    sets.set(v, cur); return cur;
  };
  const top = down(root, 0);
  const lengths = new Map<string, number>(); let score = 0;
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const state0 = new Uint8Array(np); // leaf 0 is the root's other neighbour: its state is fixed
  for (let p = 0; p < np; p++) state0[p] = low(P.codes[0][p] & top[p]) || low(P.codes[0][p]);
  const rootState = new Uint8Array(np);
  let ch0 = 0;
  for (let p = 0; p < np; p++) { const common = P.codes[0][p] & top[p]; rootState[p] = common ? low(common) : low(top[p]); if (!common) ch0 += P.weights[p]; }
  lengths.set(key(0, root), ch0); score += ch0;
  const up = (v: number, par: number, st: Uint8Array) => {
    if (v < t.n) return;
    for (const w of t.adj.get(v)!.keys()) {
      if (w === par) continue;
      const sw = sets.get(w)!, ws = new Uint8Array(np); let ch = 0;
      for (let p = 0; p < np; p++) { if (sw[p] & st[p]) ws[p] = st[p]; else { ws[p] = low(sw[p]); ch += P.weights[p]; } }
      lengths.set(key(v, w), ch); score += ch; up(w, v, ws);
    }
  };
  up(root, 0, rootState);
  for (const [k, v] of lengths) lengths.set(k, v / P.sites);
  return { lengths, score };
}
export function maximumParsimony(start: UTree, rows: string[], o: Parameters<typeof hillClimb>[2] = {}) {
  const P = patterns(rows);
  const r = hillClimb(start, (t) => fitch(t, P), o);
  const { lengths, score } = parsimonyBranchLengths(r.tree, P);
  return { tree: applyLengths(r.tree, lengths), score, rounds: r.rounds, sites: P.sites };
}
void treeLength;
