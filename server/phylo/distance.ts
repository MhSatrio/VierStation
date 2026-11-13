// Alignment preparation (gap treatment) and nucleotide distance models. Formulas follow Jukes & Cantor 1969, Kimura 1980, Tamura & Nei 1993.
export type GapTreatment = { mode: 'pairwise' } | { mode: 'complete' } | { mode: 'partial'; cutoff: number };
export type DistModel = 'p' | 'jc69' | 'k2p' | 'tn93';
export interface Dist { D: number[][]; compared: number[][]; saturated: number; warnings: string[] }

const isBase = (c: string) => c === 'A' || c === 'C' || c === 'G' || c === 'T';

export function prepareColumns(rows: string[], gap: GapTreatment): { rows: string[]; kept: number; dropped: number } {
  const L = rows[0]?.length ?? 0;
  if (rows.some((r) => r.length !== L)) throw new Error('All sequences in an alignment must have the same length');
  const up = rows.map((r) => r.toUpperCase().replace(/U/g, 'T'));
  const keep: number[] = [];
  for (let c = 0; c < L; c++) {
    let bad = 0;
    for (const r of up) if (!isBase(r[c])) bad++;
    if (gap.mode === 'pairwise') { if (bad < up.length) keep.push(c); } // an all-gap column carries no information
    else if (gap.mode === 'complete') { if (bad === 0) keep.push(c); }
    else if (bad / up.length <= gap.cutoff / 100) keep.push(c);
  }
  return { rows: up.map((r) => keep.map((c) => r[c]).join('')), kept: keep.length, dropped: L - keep.length };
}

export function baseFrequencies(rows: string[]): [number, number, number, number] {
  const f = [0, 0, 0, 0]; let t = 0;
  for (const r of rows) for (const c of r) { const i = 'ACGT'.indexOf(c); if (i >= 0) { f[i]++; t++; } }
  return t ? (f.map((x) => x / t) as [number, number, number, number]) : [0.25, 0.25, 0.25, 0.25];
}

const PUR = new Set(['A', 'G']);
/** Pairwise count of compared sites, transitions (split by purine/pyrimidine) and transversions. */
function pairCounts(a: string, b: string) {
  let n = 0, p1 = 0, p2 = 0, q = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!isBase(x) || !isBase(y)) continue;
    n++;
    if (x === y) continue;
    if (PUR.has(x) === PUR.has(y)) { if (PUR.has(x)) p1++; else p2++; } else q++;
  }
  return { n, p1, p2, q };
}

export function distanceMatrix(rows: string[], model: DistModel, gammaAlpha?: number): Dist {
  const n = rows.length, D = Array.from({ length: n }, () => new Array(n).fill(0)), compared = Array.from({ length: n }, () => new Array(n).fill(0));
  const warnings: string[] = []; let saturated = 0;
  const [pA, pC, pG, pT] = baseFrequencies(rows), pR = pA + pG, pY = pC + pT;
  const a = gammaAlpha && gammaAlpha > 0 ? gammaAlpha : 0;
  const lg = (x: number) => (a ? (a / 1) * (x ** (-1 / a) - 1) : -Math.log(x)); // −ln(x) or the gamma-corrected equivalent
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const { n: m, p1, p2, q } = pairCounts(rows[i], rows[j]);
    compared[i][j] = compared[j][i] = m;
    let d = 3;
    if (m < 20) { warnings.push(`${i}-${j}`); d = 3; saturated++; }
    else {
      const P1 = p1 / m, P2 = p2 / m, P = P1 + P2, Q = q / m, pd = P + Q;
      let ok = true, v = 0;
      if (model === 'p') v = pd;
      else if (model === 'jc69') { const x = 1 - (4 / 3) * pd; ok = x > 0; v = ok ? 0.75 * lg(x) : 3; }
      else if (model === 'k2p') { const x1 = 1 - 2 * P - Q, x2 = 1 - 2 * Q; ok = x1 > 0 && x2 > 0; v = ok ? 0.5 * lg(x1) + 0.25 * lg(x2) : 3; }
      else {
        const t1 = 1 - (pR / (2 * pA * pG)) * P1 - Q / (2 * pR), t2 = 1 - (pY / (2 * pC * pT)) * P2 - Q / (2 * pY), t3 = 1 - Q / (2 * pR * pY);
        ok = t1 > 0 && t2 > 0 && t3 > 0;
        v = ok ? ((2 * pA * pG) / pR) * lg(t1) + ((2 * pC * pT) / pY) * lg(t2) + 2 * (pR * pY - (pA * pG * pY) / pR - (pC * pT * pR) / pY) * lg(t3) : 3;
      }
      d = Math.min(3, Math.max(0, v)); if (!ok || d >= 3) saturated++;
    }
    D[i][j] = D[j][i] = d;
  }
  return { D, compared, saturated, warnings: warnings.length ? [`${warnings.length} sequence pair(s) share fewer than 20 comparable sites; their distances were set to the cap (3.0) and are unreliable.`] : [] };
}
