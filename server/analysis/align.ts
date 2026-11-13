// Sequence alignment: Gotoh affine-gap global (Needleman-Wunsch) and local (Smith-Waterman) pairwise alignment,
// star-based multiple alignment, identity/similarity, and k-mer distances. Pure TypeScript, no dependencies.
import { cleanSeq } from '../../shared/sequence.ts';

// BLOSUM62 (NCBI order).
const B62_ORDER = 'ARNDCQEGHILKMFPSTWYVBZX*';
const B62 = [
  [4, -1, -2, -2, 0, -1, -1, 0, -2, -1, -1, -1, -1, -2, -1, 1, 0, -3, -2, 0, -2, -1, 0, -4],
  [-1, 5, 0, -2, -3, 1, 0, -2, 0, -3, -2, 2, -1, -3, -2, -1, -1, -3, -2, -3, -1, 0, -1, -4],
  [-2, 0, 6, 1, -3, 0, 0, 0, 1, -3, -3, 0, -2, -3, -2, 1, 0, -4, -2, -3, 3, 0, -1, -4],
  [-2, -2, 1, 6, -3, 0, 2, -1, -1, -3, -4, -1, -3, -3, -1, 0, -1, -4, -3, -3, 4, 1, -1, -4],
  [0, -3, -3, -3, 9, -3, -4, -3, -3, -1, -1, -3, -1, -2, -3, -1, -1, -2, -2, -1, -3, -3, -2, -4],
  [-1, 1, 0, 0, -3, 5, 2, -2, 0, -3, -2, 1, 0, -3, -1, 0, -1, -2, -1, -2, 0, 3, -1, -4],
  [-1, 0, 0, 2, -4, 2, 5, -2, 0, -3, -3, 1, -2, -3, -1, 0, -1, -3, -2, -2, 1, 4, -1, -4],
  [0, -2, 0, -1, -3, -2, -2, 6, -2, -4, -4, -2, -3, -3, -2, 0, -2, -2, -3, -3, -1, -2, -1, -4],
  [-2, 0, 1, -1, -3, 0, 0, -2, 8, -3, -3, -1, -2, -1, -2, -1, -2, -2, 2, -3, 0, 0, -1, -4],
  [-1, -3, -3, -3, -1, -3, -3, -4, -3, 4, 2, -3, 1, 0, -3, -2, -1, -3, -1, 3, -3, -3, -1, -4],
  [-1, -2, -3, -4, -1, -2, -3, -4, -3, 2, 4, -2, 2, 0, -3, -2, -1, -2, -1, 1, -4, -3, -1, -4],
  [-1, 2, 0, -1, -3, 1, 1, -2, -1, -3, -2, 5, -1, -3, -1, 0, -1, -3, -2, -2, 0, 1, -1, -4],
  [-1, -1, -2, -3, -1, 0, -2, -3, -2, 1, 2, -1, 5, 0, -2, -1, -1, -1, -1, 1, -3, -1, -1, -4],
  [-2, -3, -3, -3, -2, -3, -3, -3, -1, 0, 0, -3, 0, 6, -4, -2, -2, 1, 3, -1, -3, -3, -1, -4],
  [-1, -2, -2, -1, -3, -1, -1, -2, -2, -3, -3, -1, -2, -4, 7, -1, -1, -4, -3, -2, -2, -1, -2, -4],
  [1, -1, 1, 0, -1, 0, 0, 0, -1, -2, -2, 0, -1, -2, -1, 4, 1, -3, -2, -2, 0, 0, 0, -4],
  [0, -1, 0, -1, -1, -1, -1, -2, -2, -1, -1, -1, -1, -2, -1, 1, 5, -2, -2, 0, -1, -1, 0, -4],
  [-3, -3, -4, -4, -2, -2, -3, -2, -2, -3, -2, -3, -1, 1, -4, -3, -2, 11, 2, -3, -4, -3, -2, -4],
  [-2, -2, -2, -3, -2, -1, -2, -3, 2, -1, -1, -2, -1, 3, -3, -2, -2, 2, 7, -1, -3, -2, -1, -4],
  [0, -3, -3, -3, -1, -2, -2, -3, -3, 3, 1, -2, 1, -1, -2, -2, 0, -3, -1, 4, -3, -2, -1, -4],
  [-2, -1, 3, 4, -3, 0, 1, -1, 0, -3, -4, 0, -3, -3, -2, 0, -1, -4, -3, -3, 4, 1, -1, -4],
  [-1, 0, 0, 1, -3, 3, 4, -2, 0, -3, -3, 1, -1, -3, -1, 0, -1, -3, -2, -2, 1, 4, -1, -4],
  [0, -1, -1, -1, -2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -2, 0, 0, -2, -1, -1, -1, -1, -1, -4],
  [-4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, 1],
];
const B62_IX: Record<string, number> = {};
[...B62_ORDER].forEach((c, i) => (B62_IX[c] = i));

export type SeqType = 'dna' | 'protein';
export interface AlignParams { mode: 'global' | 'local'; seqType: SeqType; gapOpen: number; gapExtend: number; match: number; mismatch: number }

export const defaultParams = (seqType: SeqType, mode: 'global' | 'local' = 'global'): AlignParams =>
  seqType === 'protein' ? { mode, seqType, gapOpen: 11, gapExtend: 1, match: 0, mismatch: 0 } : { mode, seqType, gapOpen: 5, gapExtend: 2, match: 2, mismatch: -3 };

export function scorePair(a: string, b: string, p: AlignParams): number {
  if (p.seqType === 'protein') return B62[B62_IX[a] ?? 22][B62_IX[b] ?? 22];
  if (a === 'N' || b === 'N') return 0;
  return a === b ? p.match : p.mismatch;
}

export interface Alignment {
  a: string; b: string; score: number; identity: number; similarity: number; gaps: number; length: number; identityPct: number; similarityPct: number;
  startA: number; endA: number; startB: number; endB: number; mode: 'global' | 'local';
}

const NEG = -1e9;

/** Gotoh algorithm with traceback. Memory O(n*m) bytes for pointers (Uint8Array) – fine up to ~8k x 8k. */
export function pairwise(sa: string, sb: string, p: AlignParams): Alignment {
  const A = cleanSeq(sa).replace(/-/g, ''), B = cleanSeq(sb).replace(/-/g, '');
  const n = A.length, m = B.length;
  if (n * m > 64_000_000) throw new Error(`Sequences too long for pairwise alignment (${n} x ${m}); limit is 64M cells`);
  const local = p.mode === 'local';
  const go = p.gapOpen, ge = p.gapExtend;
  const W = m + 1;
  const M = new Float32Array((n + 1) * W), X = new Float32Array((n + 1) * W), Y = new Float32Array((n + 1) * W); // match / gap-in-B (consume A) / gap-in-A (consume B)
  const tb = new Uint8Array((n + 1) * W * 3); // traceback pointers per state
  const idx = (i: number, j: number) => i * W + j;
  M[0] = 0; X[0] = Y[0] = NEG;
  for (let i = 1; i <= n; i++) { M[idx(i, 0)] = local ? 0 : NEG; Y[idx(i, 0)] = NEG; X[idx(i, 0)] = local ? 0 : -go - ge * (i - 1); }
  for (let j = 1; j <= m; j++) { M[idx(0, j)] = local ? 0 : NEG; X[idx(0, j)] = NEG; Y[idx(0, j)] = local ? 0 : -go - ge * (j - 1); }
  let best = local ? 0 : NEG, bi = 0, bj = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const k = idx(i, j), d = idx(i - 1, j - 1), up = idx(i - 1, j), lf = idx(i, j - 1);
      const s = scorePair(A[i - 1], B[j - 1], p);
      // M: diagonal
      let mv = M[d], mt = 0;
      if (X[d] > mv) { mv = X[d]; mt = 1; }
      if (Y[d] > mv) { mv = Y[d]; mt = 2; }
      let mscore = mv + s;
      if (local && mscore < 0) { mscore = 0; mt = 3; }
      M[k] = mscore; tb[k * 3] = mt;
      // X: gap in B (move down). May open from M, extend X, or open directly after a gap in A (Y) – needed for optimality
      // whenever two adjacent gap columns score better than a poor mismatch.
      let xv = M[up] - go, xt = 0;
      if (X[up] - ge > xv) { xv = X[up] - ge; xt = 1; }
      if (Y[up] - go > xv) { xv = Y[up] - go; xt = 2; }
      X[k] = xv; tb[k * 3 + 1] = xt;
      // Y: gap in A (move right)
      let yv = M[lf] - go, yt = 0;
      if (Y[lf] - ge > yv) { yv = Y[lf] - ge; yt = 2; }
      if (X[lf] - go > yv) { yv = X[lf] - go; yt = 1; }
      Y[k] = yv; tb[k * 3 + 2] = yt;
      if (local && mscore > best) { best = mscore; bi = i; bj = j; }
    }
  }
  let i = n, j = m, state = 0;
  if (local) { i = bi; j = bj; state = 0; }
  else {
    const k = idx(n, m);
    best = M[k]; state = 0;
    if (X[k] > best) { best = X[k]; state = 1; }
    if (Y[k] > best) { best = Y[k]; state = 2; }
  }
  const ra: string[] = [], rb: string[] = [];
  const endA = i, endB = j;
  while (i > 0 || j > 0) {
    const k = idx(i, j);
    if (local && state === 0 && M[k] <= 0) break;
    if (state === 0) {
      if (i === 0 || j === 0) break;
      ra.push(A[i - 1]); rb.push(B[j - 1]);
      const t = tb[k * 3];
      if (t === 3) { i--; j--; break; }
      state = t; i--; j--;
    } else if (state === 1) {
      if (i === 0) break;
      ra.push(A[i - 1]); rb.push('-');
      state = tb[k * 3 + 1]; i--;
    } else {
      if (j === 0) break;
      ra.push('-'); rb.push(B[j - 1]);
      state = tb[k * 3 + 2]; j--;
    }
  }
  const startA = i, startB = j;
  if (!local) { while (i > 0) { ra.push(A[i - 1]); rb.push('-'); i--; } while (j > 0) { ra.push('-'); rb.push(B[j - 1]); j--; } }
  const a = ra.reverse().join(''), b = rb.reverse().join('');
  return stats(a, b, best, p, { startA: local ? startA : 0, endA: local ? endA : n, startB: local ? startB : 0, endB: local ? endB : m });
}

function stats(a: string, b: string, score: number, p: AlignParams, pos: { startA: number; endA: number; startB: number; endB: number }): Alignment {
  let id = 0, sim = 0, gaps = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-' || b[i] === '-') { gaps++; continue; }
    if (a[i] === b[i]) { id++; sim++; } else if (p.seqType === 'protein' && scorePair(a[i], b[i], p) > 0) sim++;
  }
  const len = a.length;
  return { a, b, score: Math.round(score * 100) / 100, identity: id, similarity: sim, gaps, length: len, identityPct: len ? Math.round((id / len) * 1000) / 10 : 0, similarityPct: len ? Math.round((sim / len) * 1000) / 10 : 0, mode: p.mode, ...pos };
}

/** Pairwise identity over aligned (non-gap) columns, used for distance matrices. */
export function identityOverAligned(a: string, b: string): number {
  let id = 0, cols = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] === '-' || b[i] === '-') continue; cols++; if (a[i] === b[i]) id++; }
  return cols ? id / cols : 0;
}

export interface MsaResult { labels: string[]; rows: string[]; length: number; conservation: number[]; consensus: string; method: string; centerIndex: number }

/**
 * Star alignment: choose the sequence with the highest summed pairwise score as the centre, align everything to it, and merge
 * the gap columns ("once a gap, always a gap"). Fast and deterministic; not as accurate as ClustalO/MAFFT on divergent sets,
 * and the exported script uses Biopython/R so users can cross-check with a dedicated aligner.
 */
export function msa(labels: string[], seqs: string[], p: AlignParams): MsaResult {
  const S = seqs.map((s) => cleanSeq(s).replace(/-/g, ''));
  const n = S.length;
  if (n < 2) throw new Error('Select at least two sequences');
  if (n > 60) throw new Error('Multiple alignment is limited to 60 sequences');
  let centre = 0;
  if (n > 2) {
    const totals = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const sc = pairwise(S[i], S[j], { ...p, mode: 'global' }).score; totals[i] += sc; totals[j] += sc; }
    centre = totals.indexOf(Math.max(...totals));
  }
  const c = S[centre];
  const pair = S.map((s, i) => (i === centre ? null : pairwise(c, s, { ...p, mode: 'global' })));
  // for each centre position, the max number of insertions placed before it by any sequence
  const ins = new Array(c.length + 1).fill(0);
  const insPerSeq = pair.map((al) => {
    if (!al) return null;
    const arr = new Array(c.length + 1).fill(0);
    let pos = 0;
    for (let k = 0; k < al.a.length; k++) { if (al.a[k] === '-') arr[pos]++; else pos++; }
    for (let t = 0; t <= c.length; t++) ins[t] = Math.max(ins[t], arr[t]);
    return arr;
  });
  const rows: string[] = [];
  for (let s = 0; s < n; s++) {
    let out = '';
    if (s === centre) {
      for (let t = 0; t <= c.length; t++) { out += '-'.repeat(ins[t]); if (t < c.length) out += c[t]; }
    } else {
      const al = pair[s]!;
      let pos = 0, k = 0;
      const arr = insPerSeq[s]!;
      for (let t = 0; t <= c.length; t++) {
        // insertions of this sequence before centre position t
        let got = '';
        while (k < al.a.length && al.a[k] === '-') { got += al.b[k]; k++; }
        out += got + '-'.repeat(ins[t] - arr[t]);
        if (t < c.length) { out += al.b[k]; k++; pos++; }
      }
      void pos;
    }
    rows.push(out);
  }
  const L = rows[0].length;
  const conservation: number[] = [];
  let consensus = '';
  for (let col = 0; col < L; col++) {
    const cnt = new Map<string, number>();
    for (const r of rows) cnt.set(r[col], (cnt.get(r[col]) ?? 0) + 1);
    let top = '-', topN = 0;
    for (const [ch, k] of cnt) if (k > topN) { top = ch; topN = k; }
    conservation.push(Math.round((topN / n) * 1000) / 1000);
    consensus += topN / n >= 0.5 ? top : '.';
  }
  return { labels, rows, length: L, conservation, consensus, method: 'star alignment (affine gaps)', centerIndex: centre };
}

// ---- k-mer comparison ----
export function kmerProfile(seq: string, k: number): Map<string, number> {
  const s = cleanSeq(seq).replace(/-/g, '');
  const m = new Map<string, number>();
  for (let i = 0; i + k <= s.length; i++) { const w = s.slice(i, i + k); m.set(w, (m.get(w) ?? 0) + 1); }
  return m;
}
/** Cosine similarity of k-mer count vectors (alignment-free). */
export function kmerSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { na += v * v; const w = b.get(k); if (w) dot += v * w; }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
