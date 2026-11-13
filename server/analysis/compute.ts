// Pure analysis dispatch: (type, input, params) -> result. Runs inside a worker thread so the server stays responsive.
import { gcContent, composition, cleanSeq } from '../../shared/sequence.ts';
import { clusterOrder, correlationMatrix, describe, jcDistance, neighborJoining, newick, upgma, welch, pca } from './stats.ts';
import type { TreeNode } from './stats.ts';
import { defaultParams, identityOverAligned, kmerProfile, kmerSimilarity, msa, pairwise } from './align.ts';
import type { AlignParams, SeqType } from './align.ts';

export type AnalysisType = 'alignment' | 'comparison' | 'heatmap' | 'pca' | 'statistics' | 'phylogeny';
export const ANALYSIS_TYPES: { type: AnalysisType; label: string; needs: 'sequences' | 'matrix'; description: string }[] = [
  { type: 'alignment', label: 'Sequence alignment', needs: 'sequences', description: 'Pairwise (global/local, affine gaps) or star multiple alignment with conservation.' },
  { type: 'comparison', label: 'Sequence comparison', needs: 'sequences', description: 'Pairwise identity matrix (alignment or k-mer based) plus length, GC and composition.' },
  { type: 'phylogeny', label: 'Phylogenetic tree', needs: 'sequences', description: 'Multiple alignment → Jukes-Cantor distances → neighbor-joining or UPGMA tree.' },
  { type: 'heatmap', label: 'Heatmap', needs: 'matrix', description: 'Records × numeric fields with optional scaling and hierarchical clustering.' },
  { type: 'pca', label: 'PCA', needs: 'matrix', description: 'Principal components of the numeric fields (centered, optionally scaled).' },
  { type: 'statistics', label: 'Statistical summary', needs: 'matrix', description: 'Descriptive statistics, correlations and optional two-group Welch t-tests.' },
];

export interface SeqInput { id: string; label: string; seq: string }
export interface MatrixInput { rowIds: string[]; rowLabels: string[]; colNames: string[]; colIds: string[]; values: (number | null)[][]; groups?: (string | null)[]; groupName?: string }
export interface AnalysisInput { sequences?: SeqInput[]; seqType?: SeqType; matrix?: MatrixInput }
export type Params = Record<string, any>;

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function seqParams(seqType: SeqType, p: Params): AlignParams {
  const d = defaultParams(seqType, p.mode === 'local' ? 'local' : 'global');
  return {
    ...d,
    gapOpen: Number.isFinite(Number(p.gapOpen)) && p.gapOpen !== undefined ? Number(p.gapOpen) : d.gapOpen,
    gapExtend: Number.isFinite(Number(p.gapExtend)) && p.gapExtend !== undefined ? Number(p.gapExtend) : d.gapExtend,
    match: Number.isFinite(Number(p.match)) && p.match !== undefined ? Number(p.match) : d.match,
    mismatch: Number.isFinite(Number(p.mismatch)) && p.mismatch !== undefined ? Number(p.mismatch) : d.mismatch,
  };
}

export function compute(type: AnalysisType, input: AnalysisInput, params: Params): any {
  switch (type) {
    case 'alignment': return alignment(input, params);
    case 'comparison': return comparison(input, params);
    case 'phylogeny': return phylogeny(input, params);
    case 'heatmap': return heatmap(input, params);
    case 'pca': return pcaAnalysis(input, params);
    case 'statistics': return statistics(input, params);
  }
  throw new Error(`Unknown analysis type ${type}`);
}

function needSeqs(input: AnalysisInput, min = 2): SeqInput[] {
  const s = input.sequences ?? [];
  if (s.length < min) throw new Error(`Select at least ${min} records that have a sequence`);
  if (s.length > 200) throw new Error('At most 200 sequences per analysis');
  return s;
}

function alignment(input: AnalysisInput, params: Params) {
  const seqs = needSeqs(input);
  const st = input.seqType ?? 'dna';
  const p = seqParams(st, params);
  if (seqs.length === 2 && params.mode !== 'msa') {
    const al = pairwise(seqs[0].seq, seqs[1].seq, p);
    return { kind: 'pairwise', params: p, labels: [seqs[0].label, seqs[1].label], alignment: al };
  }
  const m = msa(seqs.map((s) => s.label), seqs.map((s) => s.seq), { ...p, mode: 'global' });
  const ident: number[][] = seqs.map((_, i) => seqs.map((__, j) => (i === j ? 1 : r3(identityOverAligned(m.rows[i], m.rows[j])))));
  return { kind: 'msa', params: p, ...m, identity: ident };
}

function comparison(input: AnalysisInput, params: Params) {
  const seqs = needSeqs(input);
  const st = input.seqType ?? 'dna';
  const method: 'alignment' | 'kmer' = params.method === 'kmer' || seqs.length > 40 ? 'kmer' : 'alignment';
  const k = Number(params.k) || (st === 'dna' ? 6 : 3);
  const n = seqs.length;
  const M = Array.from({ length: n }, () => new Array(n).fill(1));
  if (method === 'alignment') {
    const p = seqParams(st, { ...params, mode: 'global' });
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const a = pairwise(seqs[i].seq, seqs[j].seq, p); M[i][j] = M[j][i] = r3(a.identity / Math.max(1, Math.min(cleanSeq(seqs[i].seq).length, cleanSeq(seqs[j].seq).length))); }
  } else {
    const prof = seqs.map((s) => kmerProfile(s.seq, k));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) M[i][j] = M[j][i] = r3(kmerSimilarity(prof[i], prof[j]));
  }
  const per = seqs.map((s) => {
    const clean = cleanSeq(s.seq);
    const comp = composition(clean);
    return { id: s.id, label: s.label, length: clean.length, gc: st === 'dna' ? r3(gcContent(clean)) : null, composition: Object.fromEntries(Object.entries(comp).map(([a, c]) => [a, r3(c / Math.max(1, clean.length))])) };
  });
  return { method, k: method === 'kmer' ? k : null, metric: method === 'alignment' ? 'identical positions / length of the shorter sequence (global alignment)' : `cosine similarity of ${k}-mer counts`, labels: seqs.map((s) => s.label), matrix: M, sequences: per };
}

function phylogeny(input: AnalysisInput, params: Params) {
  const seqs = needSeqs(input, 3);
  const st = input.seqType ?? 'dna';
  if (seqs.length > 60) throw new Error('Phylogeny is limited to 60 sequences');
  const p = seqParams(st, { ...params, mode: 'global' });
  const m = msa(seqs.map((s) => s.label), seqs.map((s) => s.seq), p);
  const n = seqs.length;
  const D = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) D[i][j] = D[j][i] = r3(jcDistance(m.rows[i], m.rows[j], st));
  const method = params.method === 'upgma' ? 'upgma' : 'nj';
  const tree: TreeNode = method === 'upgma' ? upgma(m.labels, D) : neighborJoining(m.labels, D);
  return { method, params: p, distance: st === 'dna' ? 'Jukes-Cantor' : 'Poisson-corrected (protein)', labels: m.labels, alignedRows: m.rows, distanceMatrix: D, newick: newick(tree), tree, alignmentLength: m.length };
}

function matrixOf(input: AnalysisInput) {
  const mx = input.matrix;
  if (!mx || !mx.values.length) throw new Error('No numeric data: choose records and numeric fields');
  return mx;
}

function heatmap(input: AnalysisInput, params: Params) {
  const mx = matrixOf(input);
  const scale: 'none' | 'row' | 'column' = ['row', 'column'].includes(params.scale) ? params.scale : 'none';
  const V = mx.values.map((r) => r.slice());
  const rows = V.length, cols = V[0].length;
  if (scale === 'column') for (let j = 0; j < cols; j++) { const col = V.map((r) => r[j]); const s = describe(col); for (let i = 0; i < rows; i++) if (V[i][j] !== null) V[i][j] = s.sd ? (V[i][j]! - s.mean!) / s.sd : 0; }
  if (scale === 'row') for (let i = 0; i < rows; i++) { const s = describe(V[i]); for (let j = 0; j < cols; j++) if (V[i][j] !== null) V[i][j] = s.sd ? (V[i][j]! - s.mean!) / s.sd : 0; }
  const filled = V.map((r) => r.map((v) => v ?? 0));
  const rowOrder = params.clusterRows !== false && rows <= 500 ? clusterOrder(filled) : filled.map((_, i) => i);
  const colOrder = params.clusterCols !== false && cols >= 3 ? clusterOrder(filled[0].map((_, j) => filled.map((r) => r[j]))) : filled[0].map((_, j) => j);
  const flat = V.flat().filter((x): x is number => x !== null);
  return {
    scale, rowLabels: mx.rowLabels, colNames: mx.colNames, rowOrder, colOrder, values: V.map((r) => r.map((v) => (v === null ? null : r3(v)))),
    min: flat.length ? Math.min(...flat) : 0, max: flat.length ? Math.max(...flat) : 0, clusteredRows: params.clusterRows !== false && rows <= 500, clusteredCols: params.clusterCols !== false && cols >= 3,
  };
}

function pcaAnalysis(input: AnalysisInput, params: Params) {
  const mx = matrixOf(input);
  const r = pca(mx.values, { scale: params.scale !== false, components: Number(params.components) || 5 });
  return { ...r, rowLabels: mx.rowLabels, rowIds: mx.rowIds, colNames: mx.colNames, scaled: params.scale !== false, groups: mx.groups ?? null, groupName: mx.groupName ?? null };
}

function statistics(input: AnalysisInput, params: Params) {
  const mx = matrixOf(input);
  const cols = mx.colNames.map((_, j) => mx.values.map((r) => r[j]));
  const summary = mx.colNames.map((name, j) => ({ name, ...describe(cols[j]) }));
  const method: 'pearson' | 'spearman' = params.correlation === 'spearman' ? 'spearman' : 'pearson';
  const out: any = { summary, correlation: { method, names: mx.colNames, matrix: cols.length >= 2 ? correlationMatrix(cols, method) : [] }, rows: mx.values.length };
  if (mx.groups) {
    const levels = [...new Set(mx.groups.filter((g): g is string => g !== null))];
    if (levels.length === 2) {
      out.groupTest = { groupName: mx.groupName, levels, test: 'Welch two-sample t-test (unequal variances, two-sided)', results: mx.colNames.map((name, j) => {
        const a = cols[j].filter((v, i) => mx.groups![i] === levels[0] && v !== null) as number[];
        const b = cols[j].filter((v, i) => mx.groups![i] === levels[1] && v !== null) as number[];
        const w = welch(a, b);
        return w ? { name, ...Object.fromEntries(Object.entries(w).map(([k, v]) => [k, typeof v === 'number' ? Number(v.toPrecision(7)) : v])) } /* significant figures, not decimals: tiny p-values must not round to 0 */ : { name, error: 'needs ≥2 values in each group' };
      }) };
    } else out.groupNote = `Group field has ${levels.length} level(s); a t-test needs exactly 2.`;
  }
  return out;
}
