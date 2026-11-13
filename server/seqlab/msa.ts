// Multiple sequence alignment engines built into VierStation (no external program needed):
//   • progressive: k-mer distances → UPGMA guide tree → profile–profile alignment with affine gaps (Gotoh), merging along the guide tree
//   • iterative:   progressive result refined by "leave one out" re-alignment against the profile of the rest, kept only if the sum-of-pairs score rises
// These are textbook algorithms (Feng & Doolittle 1987 / Thompson et al. 1994 style); they are NOT MAFFT/MUSCLE/Clustal Omega and are less accurate on very divergent sets.
import { scorePair, kmerProfile, kmerSimilarity } from '../analysis/align.ts';
import type { AlignParams } from '../analysis/align.ts';
import { upgma } from '../analysis/stats.ts';
import type { TreeNode } from '../analysis/stats.ts';
import { cleanSeq } from '../../shared/sequence.ts';

export interface MsaOptions {
  method: 'progressive' | 'iterative';
  seqType: 'dna' | 'protein';
  match: number; mismatch: number; gapOpen: number; gapExtend: number;
  /** DNA only: 'transition' scores purine↔purine / pyrimidine↔pyrimidine mismatches as milder than transversions. */
  matrix: 'simple' | 'transition';
  /** Gaps at the ends of a sequence cost nothing (right for reads/regions of different lengths). */
  freeEndGaps: boolean;
  maxIterations: number;
}
export const defaultMsa = (seqType: 'dna' | 'protein' = 'dna'): MsaOptions => seqType === 'protein'
  ? { method: 'progressive', seqType, match: 0, mismatch: 0, gapOpen: 11, gapExtend: 1, matrix: 'simple', freeEndGaps: true, maxIterations: 3 }
  : { method: 'progressive', seqType, match: 2, mismatch: -3, gapOpen: 5, gapExtend: 2, matrix: 'simple', freeEndGaps: true, maxIterations: 3 };

const PUR = new Set(['A', 'G']);
function scorer(o: MsaOptions) {
  const ap: AlignParams = { mode: 'global', seqType: o.seqType, gapOpen: o.gapOpen, gapExtend: o.gapExtend, match: o.match, mismatch: o.mismatch };
  return (a: string, b: string): number => {
    if (o.seqType === 'protein') return scorePair(a, b, ap);
    if (!'ACGT'.includes(a) || !'ACGT'.includes(b)) return 0; // N and IUPAC ambiguity codes are neutral
    if (a === b) return o.match;
    if (o.matrix === 'transition' && PUR.has(a) === PUR.has(b)) return o.mismatch + 0.4 * (o.match - o.mismatch);
    return o.mismatch;
  };
}

type Col = [number, number][]; // (alphabet index, count) of the non-gap residues in one column
function columns(rows: string[], ix: Map<string, number>): Col[] {
  const L = rows[0].length, out: Col[] = [];
  for (let c = 0; c < L; c++) {
    const m = new Map<number, number>();
    for (const r of rows) { const ch = r[c]; if (ch === '-') continue; const k = ix.get(ch)!; m.set(k, (m.get(k) ?? 0) + 1); }
    out.push([...m]);
  }
  return out;
}

const NEG = -1e9;
/** Align two existing alignments (profiles). Returns all rows of P followed by all rows of Q, now of equal length. */
export function alignProfiles(P: string[], Q: string[], o: MsaOptions): string[] {
  const n = P[0].length, m = Q[0].length;
  if (n * m > 64_000_000) throw new Error(`Profiles too long to align (${n} x ${m} columns)`);
  const sc = scorer(o);
  const alpha = [...new Set([...P, ...Q].flatMap((r) => [...r]).filter((c) => c !== '-'))];
  const ix = new Map(alpha.map((c, i) => [c, i]));
  const S = alpha.map((a) => alpha.map((b) => sc(a, b)));
  const cp = columns(P, ix), cq = columns(Q, ix), norm = 1 / (P.length * Q.length);
  const go = o.gapOpen, ge = o.gapExtend, free = o.freeEndGaps, W = m + 1;
  const Ms = new Float32Array((n + 1) * W).fill(NEG), Xs = new Float32Array((n + 1) * W).fill(NEG), Ys = new Float32Array((n + 1) * W).fill(NEG);
  const tb = new Uint8Array((n + 1) * W * 3);
  Ms[0] = 0;
  for (let i = 1; i <= n; i++) Xs[i * W] = free ? 0 : -go - ge * (i - 1);
  for (let j = 1; j <= m; j++) Ys[j] = free ? 0 : -go - ge * (j - 1);
  for (let i = 1; i <= n; i++) {
    const A = cp[i - 1];
    for (let j = 1; j <= m; j++) {
      const k = i * W + j, d = k - W - 1, up = k - W, lf = k - 1;
      let s = 0;
      for (const [a, ca] of A) for (const [b, cb] of cq[j - 1]) s += ca * cb * S[a][b];
      s *= norm; // average substitution score per sequence pair (gaps in a column contribute 0, so gappy columns weigh less)
      let mv = Ms[d], mt = 0;
      if (Xs[d] > mv) { mv = Xs[d]; mt = 1; }
      if (Ys[d] > mv) { mv = Ys[d]; mt = 2; }
      Ms[k] = mv + s; tb[k * 3] = mt;
      let xv = Ms[up] - go, xt = 0;
      if (Xs[up] - ge > xv) { xv = Xs[up] - ge; xt = 1; }
      if (Ys[up] - go > xv) { xv = Ys[up] - go; xt = 2; }
      Xs[k] = xv; tb[k * 3 + 1] = xt;
      let yv = Ms[lf] - go, yt = 0;
      if (Ys[lf] - ge > yv) { yv = Ys[lf] - ge; yt = 2; }
      if (Xs[lf] - go > yv) { yv = Xs[lf] - go; yt = 1; }
      Ys[k] = yv; tb[k * 3 + 2] = yt;
    }
  }
  // end point
  let bi = n, bj = m, bs = 0, best = NEG;
  const consider = (i: number, j: number) => {
    const k = i * W + j;
    for (const [st, arr] of [[0, Ms], [1, Xs], [2, Ys]] as const) if (arr[k] > best) { best = arr[k]; bi = i; bj = j; bs = st; }
  };
  if (free) { for (let j = 0; j <= m; j++) consider(n, j); for (let i = 0; i <= n; i++) consider(i, m); } else consider(n, m);
  const ops: ('M' | 'X' | 'Y')[] = [];
  for (let i = n; i > bi; i--) ops.push('X');
  for (let j = m; j > bj; j--) ops.push('Y');
  let i = bi, j = bj, st = bs;
  while (i > 0 || j > 0) {
    if (j === 0) { ops.push('X'); i--; continue; }
    if (i === 0) { ops.push('Y'); j--; continue; }
    const k = i * W + j;
    if (st === 0) { ops.push('M'); st = tb[k * 3]; i--; j--; }
    else if (st === 1) { ops.push('X'); st = tb[k * 3 + 1]; i--; }
    else { ops.push('Y'); st = tb[k * 3 + 2]; j--; }
  }
  ops.reverse();
  const out = [...P, ...Q].map(() => [] as string[]);
  let pi = 0, qj = 0;
  for (const op of ops) {
    for (let r = 0; r < P.length; r++) out[r].push(op === 'Y' ? '-' : P[r][pi]);
    for (let r = 0; r < Q.length; r++) out[P.length + r].push(op === 'X' ? '-' : Q[r][qj]);
    if (op !== 'Y') pi++;
    if (op !== 'X') qj++;
  }
  return out.map((a) => a.join(''));
}

/** Sum-of-pairs score of an alignment with affine gaps (gap–gap columns are ignored). Higher is better. */
export function spScore(rows: string[], o: MsaOptions): number {
  const sc = scorer(o), n = rows.length, L = rows[0].length;
  let total = 0;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    let gapState = 0; // 0 none, 1 gap in a, 2 gap in b
    for (let c = 0; c < L; c++) {
      const x = rows[a][c], y = rows[b][c];
      if (x === '-' && y === '-') continue;
      if (x === '-') { total -= gapState === 1 ? o.gapExtend : o.gapOpen; gapState = 1; }
      else if (y === '-') { total -= gapState === 2 ? o.gapExtend : o.gapOpen; gapState = 2; }
      else { total += sc(x, y); gapState = 0; }
    }
  }
  return total;
}

const dropGapColumns = (rows: string[]): string[] => {
  const keep: number[] = [];
  for (let c = 0; c < rows[0].length; c++) if (rows.some((r) => r[c] !== '-')) keep.push(c);
  return rows.map((r) => keep.map((c) => r[c]).join(''));
};

export function columnSummary(rows: string[]) {
  const n = rows.length, L = rows[0].length, conservation: number[] = []; let consensus = '';
  for (let col = 0; col < L; col++) {
    const cnt = new Map<string, number>();
    for (const r of rows) cnt.set(r[col], (cnt.get(r[col]) ?? 0) + 1);
    let top = '-', topN = 0;
    for (const [ch, c] of cnt) if (c > topN) { top = ch; topN = c; }
    conservation.push(Math.round((topN / n) * 1000) / 1000);
    consensus += topN / n >= 0.5 ? top : '.';
  }
  return { conservation, consensus, length: L };
}

export interface MsaRun {
  labels: string[]; rows: string[]; length: number; conservation: number[]; consensus: string; method: string; spScore: number;
  guideTree: string; iterations: { iteration: number; spScore: number; improved: number }[]; options: MsaOptions; warnings: string[];
}

export function runMsa(labels: string[], seqs: string[], o: MsaOptions, h: { onProgress?: (done: number, total: number | null, msg: string) => void; isCancelled?: () => boolean } = {}): MsaRun {
  const S = seqs.map((s) => cleanSeq(s).replace(/-/g, ''));
  const n = S.length, warnings: string[] = [];
  if (n < 2) throw new Error('Select at least two sequences');
  if (n > 80) throw new Error('Multiple alignment is limited to 80 sequences in the built-in engine');
  if (S.some((s) => !s.length)) throw new Error('A sequence is empty');
  const k = o.seqType === 'protein' ? 3 : 7;
  const prof = S.map((s) => kmerProfile(s, k));
  const D = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) D[i][j] = D[j][i] = Math.max(0, 1 - kmerSimilarity(prof[i], prof[j]));
  let rows: string[];
  let guide = '';
  if (n === 2) { rows = alignProfiles([S[0]], [S[1]], o); guide = `(${labels[0]},${labels[1]})`; }
  else {
    const tree = upgma(labels, D);
    let merges = 0;
    const walk = (t: TreeNode): { ids: number[]; rows: string[]; nw: string } => {
      if (h.isCancelled?.()) throw new Error('Cancelled');
      if (!t.children) return { ids: [t.id], rows: [S[t.id]], nw: labels[t.id].replace(/[(),:;\s]/g, '_') };
      const parts = t.children.map(walk);
      let cur = parts[0];
      for (let c = 1; c < parts.length; c++) {
        const merged = alignProfiles(cur.rows, parts[c].rows, o);
        cur = { ids: [...cur.ids, ...parts[c].ids], rows: merged, nw: `(${cur.nw},${parts[c].nw})` };
        merges++; h.onProgress?.(merges, n - 1, `Aligning profiles (${merges}/${n - 1})`);
      }
      return cur;
    };
    const res = walk(tree);
    rows = new Array(n); res.ids.forEach((id, p) => { rows[id] = res.rows[p]; });
    guide = res.nw;
  }
  rows = dropGapColumns(rows);
  const iterations: MsaRun['iterations'] = [];
  let best = spScore(rows, o);
  iterations.push({ iteration: 0, spScore: best, improved: 0 });
  if (o.method === 'iterative' && n >= 3) {
    for (let it = 1; it <= o.maxIterations; it++) {
      let improved = 0;
      for (let s = 0; s < n; s++) {
        if (h.isCancelled?.()) throw new Error('Cancelled');
        const rest = dropGapColumns(rows.filter((_, i) => i !== s));
        const cand = alignProfiles(rest, [S[s]], o);
        const ordered = new Array<string>(n);
        let r = 0; for (let i = 0; i < n; i++) ordered[i] = i === s ? cand[cand.length - 1] : cand[r++];
        const clean = dropGapColumns(ordered), sp = spScore(clean, o);
        if (sp > best + 1e-6) { rows = clean; best = sp; improved++; }
      }
      iterations.push({ iteration: it, spScore: best, improved });
      h.onProgress?.(it, o.maxIterations, `Refinement round ${it}: ${improved} sequence(s) improved the score`);
      if (!improved) break;
    }
  }
  const { conservation, consensus, length: L } = columnSummary(rows);
  if (n > 40) warnings.push('More than 40 sequences: the built-in progressive aligner is slower and less accurate here; consider MAFFT/MUSCLE for large sets.');
  return { labels, rows, length: L, conservation, consensus, method: o.method === 'iterative' ? 'progressive + iterative refinement (built-in)' : 'progressive, profile–profile (built-in)', spScore: best, guideTree: guide + ';', iterations, options: o, warnings };
}
