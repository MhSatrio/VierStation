// Statistics, PCA, hierarchical clustering and phylogenetic trees. Pure TypeScript.

// ---------- descriptive ----------
export interface Summary { n: number; mean: number | null; sd: number | null; min: number | null; q1: number | null; median: number | null; q3: number | null; max: number | null; missing: number }

export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}
export function describe(values: (number | null | undefined)[]): Summary {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0, mean: null, sd: null, min: null, q1: null, median: null, q3: null, max: null, missing: values.length };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd, min: v[0], q1: quantile(v, 0.25), median: quantile(v, 0.5), q3: quantile(v, 0.75), max: v[n - 1], missing: values.length - n };
}

export function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}
function ranks(v: number[]): number[] {
  const ix = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length);
  for (let i = 0; i < ix.length;) { let j = i; while (j + 1 < ix.length && ix[j + 1][0] === ix[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[ix[k][1]] = avg; i = j + 1; }
  return r;
}
export const spearman = (x: number[], y: number[]) => pearson(ranks(x), ranks(y));

/** Matrix of pairwise correlations between columns, using only rows where both values are present. */
export function correlationMatrix(cols: (number | null)[][], method: 'pearson' | 'spearman'): number[][] {
  const k = cols.length;
  const out = Array.from({ length: k }, () => new Array(k).fill(NaN));
  for (let i = 0; i < k; i++) for (let j = i; j < k; j++) {
    const xs: number[] = [], ys: number[] = [];
    for (let r = 0; r < cols[i].length; r++) { const a = cols[i][r], b = cols[j][r]; if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b)) { xs.push(a); ys.push(b); } }
    const c = i === j ? 1 : method === 'spearman' ? spearman(xs, ys) : pearson(xs, ys);
    out[i][j] = out[j][i] = Number.isNaN(c) ? 0 : Math.round(c * 10000) / 10000;
  }
  return out;
}

// ---------- t distribution (Welch t-test) ----------
function lgamma(z: number): number {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function ibeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Two-sided p-value for Student's t with `df` degrees of freedom. */
export const tPValue = (t: number, df: number) => ibeta(df / 2, 0.5, df / (df + t * t));

export function welch(a: number[], b: number[]) {
  const sa = describe(a), sb = describe(b);
  if (sa.n < 2 || sb.n < 2) return null;
  const va = sa.sd! ** 2 / sa.n, vb = sb.sd! ** 2 / sb.n;
  const t = (sa.mean! - sb.mean!) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (sa.n - 1) + vb ** 2 / (sb.n - 1));
  return { t, df, p: tPValue(t, df), meanA: sa.mean!, meanB: sb.mean!, nA: sa.n, nB: sb.n };
}

// ---------- PCA ----------
export interface PcaResult { scores: number[][]; loadings: number[][]; explained: number[]; eigenvalues: number[]; components: number }

/** Jacobi eigenvalue algorithm for a symmetric matrix. Returns eigenvalues (desc) and eigenvectors as columns. */
export function jacobiEigen(Ain: number[][]): { values: number[]; vectors: number[][] } {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-14) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const order = A.map((_, i) => i).sort((i, j) => A[j][j] - A[i][i]);
  return { values: order.map((i) => A[i][i]), vectors: V.map((row) => order.map((i) => row[i])) };
}

/** PCA of an n x p matrix (rows = observations). Missing values are imputed with the column mean. Sign is fixed so the largest |loading| is positive. */
export function pca(data: (number | null)[][], opts: { scale: boolean; components?: number }): PcaResult {
  const n = data.length, p = data[0]?.length ?? 0;
  if (n < 3) throw new Error('PCA needs at least 3 rows');
  if (p < 2) throw new Error('PCA needs at least 2 numeric columns');
  // 1) impute missing values with the column mean, 2) centre, 3) optionally scale by the SD of the IMPUTED column (impute -> scale,
  // the same order the exported Python/R scripts use, so the numbers are reproducible).
  const means = new Array(p).fill(0), sds = new Array(p).fill(1);
  for (let j = 0; j < p; j++) { const col = data.map((r) => r[j]).filter((x): x is number => x !== null && Number.isFinite(x)); means[j] = col.length ? col.reduce((a, b) => a + b, 0) / col.length : 0; }
  const filled = data.map((r) => r.map((v, j) => (v === null || !Number.isFinite(v) ? means[j] : v)));
  if (opts.scale) for (let j = 0; j < p; j++) { const sd = describe(filled.map((r) => r[j])).sd; sds[j] = sd && sd > 0 ? sd : 1; }
  const X = filled.map((r) => r.map((v, j) => (v - means[j]) / sds[j]));
  const k = Math.min(opts.components ?? 5, p, n - 1);
  // covariance (p x p) – p is the number of numeric columns, normally small
  if (p > 400) throw new Error('PCA is limited to 400 numeric columns');
  const C = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let a = 0; a < p; a++) for (let b = a; b < p; b++) { let s = 0; for (let i = 0; i < n; i++) s += X[i][a] * X[i][b]; C[a][b] = C[b][a] = s / (n - 1); }
  const { values, vectors } = jacobiEigen(C);
  const total = values.reduce((a, b) => a + Math.max(b, 0), 0) || 1;
  const loadings: number[][] = [];
  for (let c = 0; c < k; c++) {
    const v = vectors.map((row) => row[c]);
    const big = v.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0);
    loadings.push(big < 0 ? v.map((x) => -x) : v);
  }
  const scores = X.map((row) => loadings.map((l) => row.reduce((s, x, j) => s + x * l[j], 0)));
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  return { scores: scores.map((r) => r.map(r4)), loadings: loadings.map((l) => l.map(r4)), explained: values.slice(0, k).map((v) => r4(Math.max(v, 0) / total)), eigenvalues: values.slice(0, k).map(r4), components: k };
}

// ---------- hierarchical clustering + trees ----------
export interface TreeNode { id: number; name?: string; length: number; children?: TreeNode[]; height?: number }

/** UPGMA on a symmetric distance matrix. Returns a rooted ultrametric tree. */
export function upgma(labels: string[], D: number[][]): TreeNode {
  let nodes: { node: TreeNode; size: number }[] = labels.map((name, i) => ({ node: { id: i, name, length: 0, height: 0 }, size: 1 }));
  let d = D.map((r) => r.slice());
  let nextId = labels.length;
  while (nodes.length > 1) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (d[i][j] < bd) { bd = d[i][j]; bi = i; bj = j; }
    const h = bd / 2;
    const a = nodes[bi], b = nodes[bj];
    a.node.length = Math.max(0, h - (a.node.height ?? 0)); b.node.length = Math.max(0, h - (b.node.height ?? 0));
    const merged = { node: { id: nextId++, length: 0, height: h, children: [a.node, b.node] } as TreeNode, size: a.size + b.size };
    const row = nodes.map((_, k) => (k === bi || k === bj ? 0 : (d[bi][k] * a.size + d[bj][k] * b.size) / (a.size + b.size)));
    const keep = nodes.map((_, k) => k).filter((k) => k !== bi && k !== bj);
    const nd = keep.map((x) => keep.map((y) => d[x][y]));
    const newNodes = keep.map((k) => nodes[k]);
    nd.forEach((r, i) => r.push(row[keep[i]]));
    nd.push([...keep.map((k) => row[k]), 0]);
    newNodes.push(merged);
    nodes = newNodes; d = nd;
  }
  return nodes[0].node;
}

/** Neighbor-Joining (Saitou & Nei). Returns an unrooted tree rendered as a trifurcating root. */
export function neighborJoining(labels: string[], D: number[][]): TreeNode {
  const n0 = labels.length;
  if (n0 < 3) throw new Error('Neighbor-joining needs at least 3 sequences');
  let nodes: TreeNode[] = labels.map((name, i) => ({ id: i, name, length: 0 }));
  let d = D.map((r) => r.slice());
  let nextId = n0;
  while (nodes.length > 3) {
    const n = nodes.length;
    const r = d.map((row) => row.reduce((a, b) => a + b, 0));
    let bi = 0, bj = 1, bq = Infinity;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const qv = (n - 2) * d[i][j] - r[i] - r[j]; if (qv < bq) { bq = qv; bi = i; bj = j; } }
    const li = d[bi][bj] / 2 + (r[bi] - r[bj]) / (2 * (n - 2)), lj = d[bi][bj] - li;
    nodes[bi].length = Math.max(0, li); nodes[bj].length = Math.max(0, lj);
    const u: TreeNode = { id: nextId++, length: 0, children: [nodes[bi], nodes[bj]] };
    const du = nodes.map((_, k) => (d[bi][k] + d[bj][k] - d[bi][bj]) / 2);
    const keep = nodes.map((_, k) => k).filter((k) => k !== bi && k !== bj);
    const nd = keep.map((x) => keep.map((y) => d[x][y]));
    nd.forEach((row, i) => row.push(du[keep[i]]));
    nd.push([...keep.map((k) => du[k]), 0]);
    nodes = [...keep.map((k) => nodes[k]), u]; d = nd;
  }
  const [a, b, c] = nodes;
  a.length = Math.max(0, (d[0][1] + d[0][2] - d[1][2]) / 2); b.length = Math.max(0, (d[0][1] + d[1][2] - d[0][2]) / 2); c.length = Math.max(0, (d[0][2] + d[1][2] - d[0][1]) / 2);
  return { id: nextId, length: 0, children: [a, b, c] };
}

export function newick(t: TreeNode): string {
  const rec = (n: TreeNode): string => (n.children ? `(${n.children.map(rec).join(',')})` : escLabel(n.name ?? '')) + `:${n.length.toFixed(5)}`;
  return rec({ ...t, length: 0 }).replace(/:0\.00000$/, '') + ';';
}
const escLabel = (s: string) => s.replace(/[\s(),:;'[\]]/g, '_');

/** Leaf order of a tree (used to order heatmap rows by clustering). */
export function leafOrder(t: TreeNode): number[] {
  return t.children ? t.children.flatMap(leafOrder) : [t.id];
}

/** Jukes-Cantor corrected distance from aligned sequences (gaps ignored pairwise). Saturated pairs are capped. */
export function jcDistance(a: string, b: string, seqType: 'dna' | 'protein'): number {
  let diff = 0, cols = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] === '-' || b[i] === '-') continue; cols++; if (a[i] !== b[i]) diff++; }
  if (!cols) return 3;
  const p = diff / cols;
  if (seqType === 'dna') { const x = 1 - (4 / 3) * p; return x <= 0.01 ? 3 : Math.max(0, -0.75 * Math.log(x)); }
  const x = 1 - (20 / 19) * p; return x <= 0.01 ? 3 : Math.max(0, -0.95 * Math.log(x));
}

/** Average-linkage ordering of rows of a matrix by Euclidean distance (for heatmaps). */
export function clusterOrder(rows: number[][]): number[] {
  const n = rows.length;
  if (n < 3) return rows.map((_, i) => i);
  const D = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { let s = 0; for (let k = 0; k < rows[i].length; k++) s += (rows[i][k] - rows[j][k]) ** 2; D[i][j] = D[j][i] = Math.sqrt(s); }
  return leafOrder(upgma(rows.map((_, i) => String(i)), D));
}
