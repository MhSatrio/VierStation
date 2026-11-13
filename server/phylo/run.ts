// Orchestration: gap treatment → distances → tree (NJ / UPGMA / ME / MP / ML) → bootstrap → rooting → interpretation helpers.
import { distanceMatrix, prepareColumns } from './distance.ts';
import type { DistModel, GapTreatment } from './distance.ts';
import { maximumLikelihood, Likelihood } from './likelihood.ts';
import type { MLModelName } from './likelihood.ts';
import { maximumParsimony, minimumEvolution, njTree, patterns, upgmaTree } from './methods.ts';
import { cloneTree, edges, link, newick, patristic, root, splits } from './tree.ts';
import type { Nested, Rooting, UTree } from './tree.ts';
import { neighborJoining, upgma } from '../analysis/stats.ts';
import type { TreeNode } from '../analysis/stats.ts';

export type Method = 'nj' | 'upgma' | 'me' | 'mp' | 'ml';
export interface PhyloParams {
  method: Method; distance: DistModel; gamma: number | null; mlModel: MLModelName; mlGamma: boolean; gap: GapTreatment; bootstrap: number; seed: number;
  rooting: 'unrooted' | 'midpoint' | 'outgroup'; outgroups: string[];
}
export const DEFAULT_PARAMS: PhyloParams = { method: 'nj', distance: 'k2p', gamma: null, mlModel: 'HKY85', mlGamma: true, gap: { mode: 'pairwise' }, bootstrap: 100, seed: 12345, rooting: 'outgroup', outgroups: [] };
export interface PhyloInput { labels: string[]; rows: string[] }
export interface PhyloResult {
  method: Method; params: PhyloParams; labels: string[]; sitesTotal: number; sitesKept: number; sitesDropped: number; informativeSites: number; variableSites: number;
  edges: [number, number, number][]; tree: Nested; newick: string; rooting: string; warnings: string[]; score?: number; scoreName?: string; model?: Record<string, unknown>;
  bootstrapDone: number; distances?: number[][]; support: Record<string, number>; saturated: number;
}

export const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export interface BuildOpts { fast?: boolean; isCancelled?: () => boolean; onRound?: (r: number, s: number) => void; fixedModel?: ReturnType<typeof defaultML> }
const defaultML = (rows: string[], p: PhyloParams) => ({ model: p.mlModel, kappa: 2, freqs: Likelihood.empiricalFreqs(rows), alpha: p.mlGamma ? 1 : null, ncat: p.mlGamma ? 4 : 1 });

/** Build the tree for already-prepared alignment rows. */
export function buildTree(labels: string[], rows: string[], p: PhyloParams, o: BuildOpts = {}) {
  const dm = distanceMatrix(rows, p.method === 'ml' || p.method === 'mp' ? 'jc69' : p.distance, p.method === 'ml' || p.method === 'mp' ? null as unknown as undefined : p.gamma ?? undefined);
  const hooks = { isCancelled: o.isCancelled, onRound: o.onRound };
  const extra: { score?: number; scoreName?: string; model?: Record<string, unknown>; rooted?: TreeNode } = {};
  let tree: UTree;
  if (p.method === 'nj') tree = njTree(labels, dm.D);
  else if (p.method === 'upgma') { const r = upgma(labels, dm.D); extra.rooted = r; tree = upgmaTree(labels, dm.D); }
  else if (p.method === 'me') { const r = minimumEvolution(njTree(labels, dm.D), dm.D, { ...hooks, maxRounds: o.fast ? 3 : 30 }); tree = r.tree; extra.score = r.score; extra.scoreName = 'Tree length (OLS sum of branch lengths)'; }
  else if (p.method === 'mp') { const r = maximumParsimony(njTree(labels, dm.D), rows, { ...hooks, maxRounds: o.fast ? 3 : 30 }); tree = r.tree; extra.score = r.score; extra.scoreName = 'Parsimony score (minimum number of changes)'; }
  else {
    const r = maximumLikelihood(njTree(labels, dm.D), rows, o.fixedModel ?? defaultML(rows, p), { ...hooks, fast: o.fast, maxRounds: o.fast ? 2 : 12 });
    tree = r.tree; extra.score = r.lnL; extra.scoreName = 'Log-likelihood';
    extra.model = { model: r.params.model, kappa: ['K80', 'HKY85'].includes(r.params.model) ? +r.params.kappa.toFixed(3) : undefined, baseFrequencies: r.params.model === 'F81' || r.params.model === 'HKY85' ? r.params.freqs.map((x) => +x.toFixed(4)) : undefined, gammaAlpha: r.params.alpha === null ? undefined : +r.params.alpha.toFixed(3), gammaCategories: r.params.alpha === null ? undefined : r.params.ncat, AIC: +r.aic.toFixed(2), BIC: +r.bic.toFixed(2), freeParameters: Math.round((r.aic + 2 * r.lnL) / 2), nniRounds: r.rounds, rawParams: r.params };
  }
  return { tree, dm, ...extra };
}

function bootOnce(labels: string[], rows: string[], p: PhyloParams, rng: () => number, fixedModel?: BuildOpts['fixedModel']) {
  const L = rows[0].length, cols = Array.from({ length: L }, () => Math.floor(rng() * L));
  const rs = rows.map((r) => cols.map((c) => r[c]).join(''));
  return new Set(splits(buildTree(labels, rs, p, { fast: true, fixedModel }).tree).keys());
}
/** Run bootstrap replicates [from, to) with a deterministic per-replicate seed; returns how often each split was seen. */
export function bootstrapChunk(labels: string[], rows: string[], p: PhyloParams, from: number, to: number, fixedModel?: BuildOpts['fixedModel'], onEach?: (done: number) => void, isCancelled?: () => boolean): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let r = from; r < to; r++) {
    if (isCancelled?.()) throw new Error('Cancelled');
    for (const k of bootOnce(labels, rows, p, mulberry32(p.seed * 1000003 + r), fixedModel)) counts[k] = (counts[k] ?? 0) + 1;
    onEach?.(r - from + 1);
  }
  return counts;
}

const informative = (rows: string[]) => {
  let inf = 0, variable = 0;
  for (let c = 0; c < rows[0].length; c++) {
    const cnt: Record<string, number> = {};
    for (const r of rows) if ('ACGT'.includes(r[c])) cnt[r[c]] = (cnt[r[c]] ?? 0) + 1;
    const states = Object.values(cnt);
    if (states.length > 1) variable++;
    if (states.filter((x) => x >= 2).length >= 2) inf++;
  }
  return { inf, variable };
};

function nestedFromRooted(t: TreeNode, labels: string[], support: Map<string, number> | null): Nested {
  const n = labels.length;
  const leaves = (x: TreeNode): number[] => (x.children ? x.children.flatMap(leaves) : [x.id]);
  const rec = (x: TreeNode, top: boolean): Nested => {
    if (!x.children) return { name: labels[x.id], leaf: x.id, length: Math.max(0, x.length) };
    const node: Nested = { length: top ? 0 : Math.max(0, x.length), children: x.children.map((c) => rec(c, false)) };
    if (!top) { let s = leaves(x).sort((a, b) => a - b); if (s.includes(0)) s = Array.from({ length: n }, (_, i) => i).filter((i) => !s.includes(i)); node.splitKey = s.join(','); node.support = support?.get(node.splitKey); }
    return node;
  };
  return rec(t, true);
}

export interface RunHooks { onProgress?: (done: number, total: number | null, msg: string) => void; isCancelled?: () => boolean; bootstrapRunner?: (labels: string[], rows: string[], p: PhyloParams, reps: number, fixedModel: BuildOpts['fixedModel'], progress: (d: number) => void) => Promise<Record<string, number>> }

export async function runPhylo(input: PhyloInput, p: PhyloParams, h: RunHooks = {}): Promise<PhyloResult> {
  const warnings: string[] = [];
  const { labels } = input;
  if (labels.length < 3) throw new Error('A tree needs at least 3 sequences');
  if (labels.length > 80) throw new Error('Trees are limited to 80 sequences in this version');
  const prep = prepareColumns(input.rows, p.gap);
  if (prep.kept < 50) throw new Error(`Only ${prep.kept} alignment column(s) remain after "${p.gap.mode}" gap treatment. Use pairwise deletion or a looser partial-deletion cutoff, or improve the alignment.`);
  const { inf, variable } = informative(prep.rows);
  if (variable < 10) throw new Error(`Only ${variable} variable site(s): the sequences are (nearly) identical in this region, so a tree would be meaningless.`);
  if (prep.kept < 300) warnings.push(`Only ${prep.kept} aligned sites are used. Short alignments can fail to separate closely related species; read the bootstrap values with caution.`);
  if (inf < 20) warnings.push(`Only ${inf} parsimony-informative sites: the data hold little phylogenetic signal.`);
  if (p.method === 'ml' && labels.length > 40) warnings.push('Maximum likelihood with more than 40 sequences can take a long time in the built-in engine.');
  h.onProgress?.(0, null, `Building ${p.method.toUpperCase()} tree`);
  const built = buildTree(labels, prep.rows, p, { isCancelled: h.isCancelled, onRound: (r, s) => h.onProgress?.(0, null, `Tree search round ${r} (score ${s.toFixed(2)})`) });
  const ref = built.tree;
  if (built.dm.saturated > 0) warnings.push(`${built.dm.saturated} pairwise distance(s) were saturated (too divergent for the chosen model). Consider a closer outgroup or a different model.`);
  warnings.push(...built.dm.warnings);

  let support: Map<string, number> | null = null; let done = 0;
  if (p.bootstrap > 0) {
    h.onProgress?.(0, p.bootstrap, 'Bootstrap');
    const fixedModel = p.method === 'ml' ? (built.model as { rawParams?: BuildOpts['fixedModel'] } | undefined)?.rawParams : undefined;
    const progress = (d: number) => { done = d; h.onProgress?.(d, p.bootstrap, 'Bootstrap replicates'); };
    const counts = h.bootstrapRunner ? await h.bootstrapRunner(prep.rows.length ? labels : labels, prep.rows, p, p.bootstrap, fixedModel, progress) : bootstrapChunk(labels, prep.rows, p, 0, p.bootstrap, fixedModel, progress, h.isCancelled);
    done = p.bootstrap;
    support = new Map(); for (const k of splits(ref).keys()) support.set(k, Math.round(((counts[k] ?? 0) / p.bootstrap) * 100));
  }
  let nested: Nested, rootingLabel: string;
  if (p.method === 'upgma' && built.rooted) { nested = nestedFromRooted(built.rooted, labels, support); rootingLabel = 'Rooted by UPGMA (assumes a constant rate of evolution – a molecular clock)'; }
  else {
    const outIdx = p.outgroups.map((l) => labels.indexOf(l)).filter((i) => i >= 0);
    const rooting: Rooting = p.rooting === 'outgroup' && outIdx.length ? { mode: 'outgroup', taxa: outIdx } : p.rooting === 'midpoint' ? { mode: 'midpoint' } : { mode: 'unrooted' };
    if (p.rooting === 'outgroup' && !outIdx.length) warnings.push('No outgroup was selected, so the tree is shown unrooted.');
    const r = root(ref, labels, support, rooting);
    nested = r.tree; rootingLabel = r.rooting; warnings.push(...r.warnings);
  }
  if (p.method === 'mp') warnings.push('Maximum-parsimony branch lengths are the number of changes per site under one most-parsimonious reconstruction (not the average-pathway lengths MEGA reports).');
  if (p.method === 'me') warnings.push('Minimum-evolution branch lengths are ordinary-least-squares estimates; small negative values are shown as 0.');
  return {
    method: p.method, params: p, labels, sitesTotal: input.rows[0].length, sitesKept: prep.kept, sitesDropped: prep.dropped, informativeSites: inf, variableSites: variable,
    edges: edges(ref), tree: nested, newick: newick(nested), rooting: rootingLabel, warnings, score: built.score, scoreName: built.scoreName, model: built.model ? Object.fromEntries(Object.entries(built.model).filter(([k]) => k !== 'rawParams')) : undefined,
    bootstrapDone: done, distances: p.method === 'ml' || p.method === 'mp' ? undefined : built.dm.D.map((r) => r.map((x) => +x.toFixed(5))), support: support ? Object.fromEntries(support) : {}, saturated: built.dm.saturated,
  };
}

/** Patristic distances from one taxon to all others in the reference tree. */
export function distancesFrom(edgesList: [number, number, number][], n: number, from: number): number[] {
  const t: UTree = { n, adj: new Map(), next: 0 };
  for (const [a, b, l] of edgesList) link(t, a, b, l);
  const d = patristic(t, from);
  return Array.from({ length: n }, (_, i) => d.get(i) ?? NaN);
}
void cloneTree; void patterns; void neighborJoining;
