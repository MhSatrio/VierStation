// Sequence cleaning operations. Pure: (version state, params) -> new state + a precise change record. Nothing here touches the database.
import { reverseComplement } from '../../shared/sequence.ts';

export interface Mark { start: number; end: number; note: string } // 1-based inclusive, on the version's own coordinates
export interface SeqState { seq: string; qual: number[] | null; map: number[] | null; marks: Mark[] } // map[i] = 0-based index in the RAW sequence

export interface Change { pos: number; from: string; to: string } // 1-based position in the INPUT version
export interface CleanResult { state: SeqState; changes: Change[]; summary: string; details: Record<string, unknown>; warnings: string[] }

export const IUPAC: Record<string, string> = { A: 'A', C: 'C', G: 'G', T: 'T', R: 'AG', Y: 'CT', S: 'CG', W: 'AT', K: 'GT', M: 'AC', B: 'CGT', D: 'AGT', H: 'ACT', V: 'ACG', N: 'ACGT' };
export const codeFor = (bases: string): string | null => { const s = [...new Set(bases.toUpperCase().split(''))].sort().join(''); return Object.entries(IUPAC).find(([, v]) => v === s)?.[0] ?? null; };
export const isAmbiguous = (c: string) => c !== 'A' && c !== 'C' && c !== 'G' && c !== 'T';

const needIdx = (s: SeqState) => s.map ?? Array.from({ length: s.seq.length }, (_, i) => i);
const slice = (s: SeqState, a: number, b: number): SeqState => ({
  seq: s.seq.slice(a, b), qual: s.qual ? s.qual.slice(a, b) : null, map: s.map ? s.map.slice(a, b) : null,
  marks: s.marks.map((m) => ({ ...m, start: m.start - a, end: m.end - a })).filter((m) => m.end >= 1 && m.start <= b - a).map((m) => ({ ...m, start: Math.max(1, m.start), end: Math.min(b - a, m.end) })),
});
const trimResult = (s: SeqState, a: number, b: number, what: string, details: Record<string, unknown>): CleanResult => {
  if (b - a < 1) throw new Error(`${what} would remove the entire sequence. Loosen the settings or trim manually.`);
  const kept = slice(s, a, b);
  const removed5 = s.seq.slice(0, a), removed3 = s.seq.slice(b);
  return {
    state: kept, changes: [], summary: `${what}: removed ${a} base(s) from the 5′ end and ${s.seq.length - b} from the 3′ end (${s.seq.length} → ${b - a} bp)`,
    details: { ...details, removed5: a, removed3: s.seq.length - b, removedSeq5: removed5.slice(-200), removedSeq3: removed3.slice(0, 200), keptRange: [a + 1, b], before: s.seq.length, after: b - a }, warnings: b - a < 100 ? ['The remaining sequence is shorter than 100 bp; short sequences may not resolve closely related species.'] : [],
  };
};

/** Sliding-window quality trim: keep from the first window whose mean Q ≥ threshold to the last such window. */
export function trimWindow(s: SeqState, threshold = 20, window = 10, ends: 'both' | '5' | '3' = 'both'): CleanResult {
  if (!s.qual) throw new Error('This sequence has no quality scores (FASTA input), so quality trimming is not possible. Trim by position instead.');
  const q = s.qual, n = q.length, w = Math.min(window, n);
  const mean = (i: number) => { let t = 0; for (let k = i; k < i + w; k++) t += q[k]; return t / w; };
  let a = 0, b = n;
  if (ends !== '3') { while (a + w <= n && mean(a) < threshold) a++; if (a + w > n) throw new Error(`No ${w}-base window reaches mean Q${threshold}. Lower the threshold.`); }
  if (ends !== '5') { b = n; while (b - w >= a && mean(b - w) < threshold) b--; }
  // a passing window can still begin/end with a few bad bases that its good neighbours averaged away: peel individual bases below the threshold off the edges
  if (ends !== '3') while (a < b - 1 && q[a] < threshold) a++;
  if (ends !== '5') while (b > a + 1 && q[b - 1] < threshold) b--;
  return trimResult(s, a, b, `Quality trim (window ${w}, mean Q ≥ ${threshold}, edge bases below Q${threshold} removed)`, { method: 'window', threshold, window: w, ends, edgePeel: true });
}

/** Modified Mott: find the segment maximising Σ(cutoff − p_err); the error-probability analogue of a Phred trim (as in Phred/Biopython). */
export function trimMott(s: SeqState, errorCutoff = 0.05): CleanResult {
  if (!s.qual) throw new Error('This sequence has no quality scores (FASTA input), so quality trimming is not possible.');
  let best = 0, bestA = 0, bestB = 0, cur = 0, curA = 0;
  s.qual.forEach((q, i) => {
    const sc = errorCutoff - 10 ** (-q / 10);
    if (cur <= 0) { cur = 0; curA = i; }
    cur += sc;
    if (cur > best) { best = cur; bestA = curA; bestB = i + 1; }
  });
  if (bestB <= bestA) throw new Error('No region meets the error cutoff. Raise the cutoff.');
  return trimResult(s, bestA, bestB, `Modified-Mott trim (error cutoff ${errorCutoff})`, { method: 'mott', errorCutoff });
}

/** Remove leading/trailing ambiguous bases (N and other IUPAC codes). */
export function trimAmbiguousEnds(s: SeqState): CleanResult {
  let a = 0, b = s.seq.length;
  while (a < b && isAmbiguous(s.seq[a])) a++;
  while (b > a && isAmbiguous(s.seq[b - 1])) b--;
  if (a === 0 && b === s.seq.length) return { state: s, changes: [], summary: 'No ambiguous bases at the sequence ends', details: { removed5: 0, removed3: 0 }, warnings: [] };
  return trimResult(s, a, b, 'Trim ambiguous ends', {});
}

export function trimRegion(s: SeqState, from: number, to: number, mode: 'keep' | 'remove'): CleanResult {
  const n = s.seq.length;
  if (!(Number.isInteger(from) && Number.isInteger(to)) || from < 1 || to > n || from > to) throw new Error(`Region must satisfy 1 ≤ from ≤ to ≤ ${n}`);
  if (mode === 'keep') return trimResult(s, from - 1, to, `Keep positions ${from}–${to}`, { mode, from, to });
  const keepA = slice(s, 0, from - 1), keepB = slice(s, to, n);
  const off = to; // marks of the right part must shift left by the removed length
  const merged: SeqState = {
    seq: keepA.seq + keepB.seq, qual: s.qual ? [...keepA.qual!, ...keepB.qual!] : null, map: s.map ? [...keepA.map!, ...keepB.map!] : null,
    marks: [...keepA.marks, ...keepB.marks.map((m) => ({ ...m, start: m.start + from - 1, end: m.end + from - 1 }))],
  };
  void off;
  if (!merged.seq.length) throw new Error('That would remove the entire sequence.');
  return { state: merged, changes: [], summary: `Removed positions ${from}–${to} (${to - from + 1} bp)`, details: { mode, from, to, removedSeq: s.seq.slice(from - 1, to).slice(0, 500), before: n, after: merged.seq.length }, warnings: [] };
}

export function removeBases(s: SeqState, chars: string): CleanResult {
  const set = new Set(chars.toUpperCase().replace(/[^A-Z\-]/g, '').split(''));
  if (!set.size) throw new Error('Choose at least one base character to remove (for example N or -).');
  const keep = s.seq.split('').map((c) => !set.has(c));
  const removed = keep.filter((k) => !k).length;
  if (!removed) return { state: s, changes: [], summary: `No ${[...set].join(', ')} bases found`, details: { chars: [...set], removed: 0 }, warnings: [] };
  const changes: Change[] = [];
  s.seq.split('').forEach((c, i) => { if (!keep[i] && changes.length < 500) changes.push({ pos: i + 1, from: c, to: '' }); });
  const idx = keep.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
  const newPos = new Map(idx.map((old, k) => [old + 1, k + 1]));
  const out: SeqState = {
    seq: idx.map((i) => s.seq[i]).join(''), qual: s.qual ? idx.map((i) => s.qual![i]) : null, map: s.map ? idx.map((i) => s.map![i]) : null,
    marks: s.marks.map((m) => { const a = idx.find((i) => i + 1 >= m.start), b = [...idx].reverse().find((i) => i + 1 <= m.end); return a !== undefined && b !== undefined && a <= b ? { ...m, start: newPos.get(a + 1)!, end: newPos.get(b + 1)! } : null; }).filter((m): m is Mark => !!m),
  };
  if (!out.seq.length) throw new Error('That would remove the entire sequence.');
  return { state: out, changes, summary: `Removed ${removed} base(s) (${[...set].join(', ')})`, details: { chars: [...set], removed }, warnings: [] };
}

/** Replace one position by a single base or an IUPAC ambiguity code. `basis` says why (manual edit, chromatogram suggestion…). */
export function editBase(s: SeqState, pos: number, base: string): CleanResult {
  const b = base.toUpperCase();
  if (!(pos >= 1 && pos <= s.seq.length)) throw new Error(`Position must be between 1 and ${s.seq.length}`);
  if (!(b in IUPAC)) throw new Error(`"${base}" is not a valid IUPAC nucleotide code (A C G T R Y S W K M B D H V N)`);
  const from = s.seq[pos - 1];
  if (from === b) return { state: s, changes: [], summary: `Position ${pos} is already ${b}`, details: { pos }, warnings: [] };
  const seq = s.seq.slice(0, pos - 1) + b + s.seq.slice(pos);
  return { state: { ...s, seq }, changes: [{ pos, from, to: b }], summary: `Position ${pos}: ${from} → ${b}${isAmbiguous(b) ? ` (IUPAC ambiguity code for ${IUPAC[b].split('').join('/')})` : ''}`, details: { pos, ambiguous: isAmbiguous(b) }, warnings: [] };
}

export function maskLowQuality(s: SeqState, threshold: number): CleanResult {
  if (!s.qual) throw new Error('No quality scores available for this sequence.');
  const chars = s.seq.split(''), changes: Change[] = [];
  s.qual.forEach((q, i) => { if (q < threshold && chars[i] !== 'N') { if (changes.length < 500) changes.push({ pos: i + 1, from: chars[i], to: 'N' }); chars[i] = 'N'; } });
  const count = s.qual.filter((q, i) => q < threshold && s.seq[i] !== 'N').length;
  return { state: { ...s, seq: chars.join('') }, changes, summary: `Replaced ${count} base(s) below Q${threshold} with N`, details: { threshold, replaced: count }, warnings: count > s.seq.length * 0.2 ? ['More than 20% of bases were masked; this read is of poor quality.'] : [] };
}

export function markRegion(s: SeqState, from: number, to: number, note: string): CleanResult {
  if (!(from >= 1 && to <= s.seq.length && from <= to)) throw new Error(`Region must satisfy 1 ≤ from ≤ to ≤ ${s.seq.length}`);
  return { state: { ...s, marks: [...s.marks, { start: from, end: to, note: note.slice(0, 200) || 'uncertain' }] }, changes: [], summary: `Marked ${from}–${to} as uncertain${note ? `: ${note}` : ''}`, details: { from, to, note }, warnings: [] };
}

export function reverseComplementOp(s: SeqState): CleanResult {
  const n = s.seq.length;
  return {
    state: { seq: reverseComplement(s.seq), qual: s.qual ? [...s.qual].reverse() : null, map: s.map ? [...s.map].reverse() : null, marks: s.marks.map((m) => ({ ...m, start: n - m.end + 1, end: n - m.start + 1 })) },
    changes: [], summary: `Reverse-complemented ${n} bp`, details: { length: n }, warnings: [],
  };
}

export function initialMap(n: number) { return n <= 50_000 ? Array.from({ length: n }, (_, i) => i) : null; }

/** Differences between the RAW sequence and a derived version, using the origin map. */
export function diffAgainstRaw(raw: string, v: SeqState) {
  const map = v.map;
  if (!map) return { available: false as const, reason: 'Position mapping is not kept for sequences longer than 50 kb.' };
  const edits: { pos: number; rawPos: number; from: string; to: string }[] = [];
  const kept = new Set<number>();
  const real = map.filter((x) => x >= 0); // -1 = base that came from a merged-in reverse read
  const reversed = real.length > 1 && real[0] > real[real.length - 1];
  v.seq.split('').forEach((c, i) => {
    const r = map[i];
    if (r < 0) { edits.push({ pos: i + 1, rawPos: 0, from: '', to: c }); return; } // base that exists only in the merged-in reverse read
    kept.add(r);
    const orig = reversed ? raw[r] : raw[r];
    const expect = reversed ? reverseComplement(orig ?? 'N') : orig;
    if (expect !== c) edits.push({ pos: i + 1, rawPos: r + 1, from: orig ?? '?', to: c });
  });
  const removed: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= raw.length; i++) { const gone = i < raw.length && !kept.has(i); if (gone && start < 0) start = i; if (!gone && start >= 0) { removed.push([start + 1, i]); start = -1; } }
  return { available: true as const, reversed, edits: edits.slice(0, 1000), editCount: edits.length, removed, removedCount: raw.length - kept.size, rawLength: raw.length, length: v.seq.length };
}
