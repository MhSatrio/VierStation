// Merge a forward read with its reverse read into ONE consensus sequence.
//   1. the reverse read is brought into the forward read's orientation (reverse-complement; "auto" tries both and keeps the better overlap)
//   2. the two reads are aligned with an overlap (end-gap-free) alignment: match +2, mismatch −3, gap −4, N/ambiguity codes 0
//   3. each overlapping column becomes one base: agreement → that base; N/ambiguous vs a real base → the real base; two different real bases →
//      the one with the clearly higher Phred score (difference ≥ qualityGap) if both reads have scores, otherwise the IUPAC code of the two
//   4. parts covered by only one read are kept as they are
// The same algorithm is ported to Python in exports.ts (merge_reverse) so the exported script reproduces the result exactly.
import { reverseComplement } from '../../shared/sequence.ts';
import { IUPAC, codeFor, isAmbiguous } from './clean.ts';
import type { Change, CleanResult, SeqState } from './clean.ts';

export const MERGE_SCORES = { match: 2, mismatch: -3, gap: 4 } as const;
export interface MergeParams { reverseSeq: string; reverseQual?: number[] | null; orientation?: 'auto' | 'as_is' | 'reverse_complement'; minOverlap?: number; minIdentity?: number; qualityGap?: number }

const isBase = (c: string) => c === 'A' || c === 'C' || c === 'G' || c === 'T';
const sc = (x: string, y: string) => (!isBase(x) || !isBase(y) ? 0 : x === y ? MERGE_SCORES.match : MERGE_SCORES.mismatch);

export interface OverlapAln { score: number; pairs: [number, number][]; i0: number; j0: number; iEnd: number; jEnd: number }
/** Overlap (semi-global) alignment: free leading/trailing gaps in BOTH sequences, linear gap cost. Deterministic tie-breaking: diagonal, then gap in b, then gap in a. */
export function overlapAlign(a: string, b: string): OverlapAln {
  const n = a.length, m = b.length, W = m + 1;
  if ((n + 1) * W > 40_000_000) throw new Error(`Reads too long to merge (${n} × ${m})`);
  const H = new Int32Array((n + 1) * W), T = new Uint8Array((n + 1) * W);
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const d = H[(i - 1) * W + j - 1] + sc(a[i - 1], b[j - 1]), u = H[(i - 1) * W + j] - MERGE_SCORES.gap, l = H[i * W + j - 1] - MERGE_SCORES.gap;
    if (d >= u && d >= l) { H[i * W + j] = d; T[i * W + j] = 0; } else if (u >= l) { H[i * W + j] = u; T[i * W + j] = 1; } else { H[i * W + j] = l; T[i * W + j] = 2; }
  }
  let bi = n, bj = 0, best = -Infinity;
  for (let j = 0; j <= m; j++) if (H[n * W + j] > best) { best = H[n * W + j]; bi = n; bj = j; }
  for (let i = 0; i <= n; i++) if (H[i * W + m] > best) { best = H[i * W + m]; bi = i; bj = m; }
  const pairs: [number, number][] = [];
  let i = bi, j = bj;
  while (i > 0 && j > 0) {
    const t = T[i * W + j];
    if (t === 0) { pairs.push([i - 1, j - 1]); i--; j--; } else if (t === 1) { pairs.push([i - 1, -1]); i--; } else { pairs.push([-1, j - 1]); j--; }
  }
  pairs.reverse();
  return { score: best, pairs, i0: i, j0: j, iEnd: bi, jEnd: bj };
}

function overlapStats(aln: OverlapAln, a: string, b: string) {
  let compared = 0, same = 0;
  for (const [x, y] of aln.pairs) if (x >= 0 && y >= 0 && isBase(a[x]) && isBase(b[y])) { compared++; if (a[x] === b[y]) same++; }
  return { columns: aln.pairs.length, compared, same, identity: compared ? same / compared : 0 };
}

const union = (x: string, y: string): string => (x === 'N' || y === 'N' ? 'N' : codeFor([...(IUPAC[x] ?? ''), ...(IUPAC[y] ?? '')].join('')) ?? 'N');

export function mergeReverse(s: SeqState, p: MergeParams): CleanResult {
  const rev = String(p.reverseSeq ?? '').toUpperCase().replace(/U/g, 'T').replace(/[^ACGTRYSWKMBDHVN]/g, '');
  if (rev.length < 30) throw new Error('The reverse read is shorter than 30 bases – too short to merge.');
  const minOverlap = p.minOverlap ?? 30, minIdentity = p.minIdentity ?? 0.8, qualityGap = p.qualityGap ?? 10;
  const rq0 = p.reverseQual && p.reverseQual.length === rev.length ? p.reverseQual : null;
  const F = s.seq;
  const cand = (rc: boolean) => ({ rc, seq: rc ? reverseComplement(rev) : rev, qual: rq0 ? (rc ? [...rq0].reverse() : rq0) : null });
  const tries = (p.orientation === 'as_is' ? [cand(false)] : p.orientation === 'reverse_complement' ? [cand(true)] : [cand(true), cand(false)]).map((c) => ({ ...c, aln: overlapAlign(F, c.seq) }));
  const chosen = tries.reduce((x, y) => (y.aln.score > x.aln.score ? y : x));
  const R = chosen.seq, rq = chosen.qual, aln = chosen.aln, st = overlapStats(aln, F, R);
  const orientationNote = p.orientation && p.orientation !== 'auto' ? `orientation fixed by the user (${chosen.rc ? 'reverse-complemented' : 'used as given'})` : `automatic: reverse-complement scored ${tries[0].aln.score}${tries[1] ? `, as given scored ${tries[1].aln.score}` : ''} → ${chosen.rc ? 'reverse-complemented' : 'used as given'}`;
  if (st.compared < Math.min(minOverlap, 20) || st.columns < minOverlap || st.identity < minIdentity)
    throw new Error(`The reads do not overlap reliably (${st.columns} overlapping columns, ${st.compared} comparable bases, ${(st.identity * 100).toFixed(1)}% identical; need ≥ ${minOverlap} columns and ≥ ${Math.round(minIdentity * 100)}% identity). They may not cover the same region, may come from different samples, or one read is too poor. Nothing was changed.`);
  const bothQ = !!(s.qual && rq);
  const out: string[] = [], oq: number[] = [], omap: number[] = [], fOut = new Array<number>(F.length).fill(-1), changes: Change[] = [];
  const stat = { agree: 0, resolved: 0, byQuality: 0, iupac: 0, ambiguousBoth: 0, indel: 0, fOnly: 0, rOnly: 0 };
  const push = (c: string, q: number | null, mp: number, fIdx: number) => { if (fIdx >= 0) fOut[fIdx] = out.length; out.push(c); if (bothQ) oq.push(q ?? 0); omap.push(mp); };
  const fMap = (i: number) => (s.map ? s.map[i] : i);
  // leading part covered by one read only
  for (let i = 0; i < aln.i0; i++) { push(F[i], s.qual ? s.qual[i] : null, fMap(i), i); stat.fOnly++; }
  for (let j = 0; j < aln.j0; j++) { push(R[j], rq ? rq[j] : null, -1, -1); stat.rOnly++; changes.length < 500 && changes.push({ pos: out.length, from: '', to: R[j] }); }
  // overlap
  for (const [x, y] of aln.pairs) {
    if (x >= 0 && y >= 0) {
      const fa = F[x], ra = R[y], qa = s.qual ? s.qual[x] : 0, qb = rq ? rq[y] : 0;
      let c: string, q: number;
      if (fa === ra) { c = fa; q = Math.max(qa, qb); if (isBase(c)) stat.agree++; else stat.ambiguousBoth++; }
      else if (isAmbiguous(fa) || isAmbiguous(ra)) {
        const fAmb = isAmbiguous(fa), rAmb = isAmbiguous(ra);
        if (fAmb && rAmb) { c = union(fa, ra); q = Math.min(qa, qb); stat.ambiguousBoth++; }
        else { const amb = fAmb ? fa : ra, real = fAmb ? ra : fa; if (amb === 'N' || IUPAC[amb].includes(real)) { c = real; q = fAmb ? qb : qa; stat.resolved++; } else { c = union(fa, ra); q = Math.min(qa, qb); stat.iupac++; } }
      } else if (bothQ && Math.abs(qa - qb) >= qualityGap) { c = qa > qb ? fa : ra; q = Math.max(qa, qb); stat.byQuality++; }
      else { c = union(fa, ra); q = Math.min(qa, qb); stat.iupac++; }
      if (c !== fa && changes.length < 500) changes.push({ pos: x + 1, from: fa, to: c });
      push(c, q, fMap(x), x);
    } else if (x >= 0) { // base in the forward read only, inside the overlap
      stat.indel++; push(F[x], s.qual ? s.qual[x] : null, fMap(x), x);
    } else { // base in the reverse read only, inside the overlap
      stat.indel++; push(R[y], rq ? rq[y] : null, -1, -1); changes.length < 500 && changes.push({ pos: out.length, from: '', to: R[y] });
    }
  }
  // trailing part covered by one read only
  for (let i = aln.iEnd; i < F.length; i++) { push(F[i], s.qual ? s.qual[i] : null, fMap(i), i); stat.fOnly++; }
  for (let j = aln.jEnd; j < R.length; j++) { push(R[j], rq ? rq[j] : null, -1, -1); stat.rOnly++; changes.length < 500 && changes.push({ pos: out.length, from: '', to: R[j] }); }
  const seq = out.join('');
  const nBefore = (F.match(/[^ACGT]/g) ?? []).length, nAfter = (seq.match(/[^ACGT]/g) ?? []).length;
  const marks = s.marks.map((m) => ({ ...m, start: (fOut[m.start - 1] ?? 0) + 1, end: (fOut[m.end - 1] ?? 0) + 1 })).filter((m) => m.start >= 1 && m.end >= m.start);
  const warnings: string[] = [];
  if (stat.indel) warnings.push(`${stat.indel} position(s) inside the overlap are present in only one of the two reads (an insertion/deletion between the reads, or a base-calling gap). They were kept; check them in the chromatograms if possible.`);
  if (stat.iupac) warnings.push(`${stat.iupac} position(s) had two different real bases with no clear quality winner; they were written as IUPAC ambiguity codes instead of choosing one.`);
  if (st.columns < 60) warnings.push(`The overlap is short (${st.columns} columns); a merge based on a short overlap is less certain.`);
  if (nAfter / seq.length > 0.1) warnings.push(`${(nAfter / seq.length * 100).toFixed(1)}% of the merged sequence is still ambiguous (N or IUPAC codes). Regions covered by only one read keep their Ns.`);
  const details = {
    method: 'overlap alignment (match +2, mismatch −3, gap −4; N/ambiguity 0) and column-wise consensus', orientation: orientationNote, reverseReadLength: rev.length, reverseHasQuality: !!rq0,
    overlapColumns: st.columns, overlapComparedBases: st.compared, overlapIdentityPct: +(st.identity * 100).toFixed(2), alignmentScore: aln.score,
    columnsAgree: stat.agree, ambiguousResolvedByOtherRead: stat.resolved, resolvedByQuality: stat.byQuality, writtenAsIupac: stat.iupac, indelColumns: stat.indel, forwardOnlyBases: stat.fOnly, reverseOnlyBases: stat.rOnly,
    ambiguousBefore: nBefore, ambiguousAfter: nAfter, qualityGap, minOverlap, minIdentity, before: F.length, after: seq.length,
  };
  return {
    state: { seq, qual: bothQ ? oq : null, map: s.map ? omap : null, marks }, changes,
    summary: `Merged with the reverse read (${chosen.rc ? 'reverse-complemented' : 'as given'}): ${F.length} → ${seq.length} bp, overlap ${st.columns} columns at ${(st.identity * 100).toFixed(1)}% identity; ambiguous bases ${nBefore} → ${nAfter} (${stat.resolved} resolved by the other read)`,
    details, warnings,
  };
}
