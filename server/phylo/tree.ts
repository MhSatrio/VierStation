// Unrooted tree structure shared by NJ / UPGMA / ME / MP / ML: leaves are 0..n-1, internal nodes n.., adjacency with branch lengths.
import type { TreeNode } from '../analysis/stats.ts';

export interface UTree { n: number; adj: Map<number, Map<number, number>>; next: number }
export interface Nested { name?: string; leaf?: number; length: number; support?: number; children?: Nested[]; splitKey?: string }

export function emptyTree(n: number): UTree { return { n, adj: new Map(), next: n } }
export function link(t: UTree, a: number, b: number, len: number) {
  if (!t.adj.has(a)) t.adj.set(a, new Map());
  if (!t.adj.has(b)) t.adj.set(b, new Map());
  t.adj.get(a)!.set(b, len); t.adj.get(b)!.set(a, len);
}
export function unlink(t: UTree, a: number, b: number) { t.adj.get(a)?.delete(b); t.adj.get(b)?.delete(a); }
export function cloneTree(t: UTree): UTree { return { n: t.n, next: t.next, adj: new Map([...t.adj].map(([k, m]) => [k, new Map(m)])) }; }
export const isLeaf = (t: UTree, v: number) => v < t.n;
export function edges(t: UTree): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const [a, m] of t.adj) for (const [b, l] of m) if (a < b) out.push([a, b, l]);
  return out;
}
export const internalEdges = (t: UTree) => edges(t).filter(([a, b]) => a >= t.n && b >= t.n);
export const treeLength = (t: UTree) => edges(t).reduce((s, e) => s + e[2], 0);

/** Convert the rooted/trifurcating trees produced by UPGMA / NJ (analysis/stats.ts) to an unrooted tree. Leaf TreeNode.id must equal the taxon index. */
export function fromTreeNode(root: TreeNode, n: number): UTree {
  const t = emptyTree(n);
  const id = new Map<TreeNode, number>();
  const assign = (x: TreeNode): number => { if (!x.children) return x.id; const v = t.next++; id.set(x, v); return v; };
  const rec = (x: TreeNode, vx: number) => { for (const c of x.children ?? []) { const vc = assign(c); link(t, vx, vc, Math.max(0, c.length)); rec(c, vc); } };
  if (root.children && root.children.length === 2) { // rooted binary: drop the root and join its children
    const [a, b] = root.children; const va = assign(a), vb = assign(b);
    link(t, va, vb, Math.max(0, a.length) + Math.max(0, b.length));
    rec(a, va); rec(b, vb);
  } else { const v = assign(root); rec(root, v); }
  return t;
}

/** The leaf set on the far side of edge a→b (i.e. reachable from b without crossing a). */
export function sideOf(t: UTree, a: number, b: number): number[] {
  const out: number[] = [], stack: [number, number][] = [[b, a]];
  while (stack.length) { const [v, p] = stack.pop()!; if (v < t.n) out.push(v); else for (const w of t.adj.get(v)!.keys()) if (w !== p) stack.push([w, v]); }
  return out.sort((x, y) => x - y);
}
/** Non-trivial bipartitions, keyed by the side that does NOT contain taxon 0. */
export function splits(t: UTree): Map<string, [number, number]> {
  const m = new Map<string, [number, number]>();
  for (const [a, b] of internalEdges(t)) { let s = sideOf(t, a, b); if (s.includes(0)) s = sideOf(t, b, a); m.set(s.join(','), [a, b]); }
  return m;
}
export const splitKeyOfEdge = (t: UTree, a: number, b: number) => { let s = sideOf(t, a, b); if (s.includes(0)) s = sideOf(t, b, a); return s.join(','); };

/** Robinson–Foulds distance between two trees on the same taxa (number of splits found in only one). */
export function rfDistance(a: UTree, b: UTree): number {
  const A = new Set(splits(a).keys()), B = new Set(splits(b).keys());
  let d = 0; for (const k of A) if (!B.has(k)) d++; for (const k of B) if (!A.has(k)) d++;
  return d;
}

/** Nearest-neighbour interchange across internal edge (u,v). variant 0/1 selects which of the two alternative resolutions. */
export function nni(t: UTree, u: number, v: number, variant: 0 | 1): UTree {
  const r = cloneTree(t);
  const [a, b] = [...r.adj.get(u)!.keys()].filter((x) => x !== v);
  const [c, d] = [...r.adj.get(v)!.keys()].filter((x) => x !== u);
  const x = variant === 0 ? c : d; // u's neighbour b trades places with v's neighbour x
  const lb = r.adj.get(u)!.get(b)!, lx = r.adj.get(v)!.get(x)!;
  unlink(r, u, b); unlink(r, v, x);
  link(r, u, x, lx); link(r, v, b, lb);
  void a;
  return r;
}

/** Sum of branch lengths from leaf i to leaf j. */
export function patristic(t: UTree, i: number): Map<number, number> {
  const dist = new Map<number, number>([[i, 0]]), stack: [number, number][] = [[i, -1]];
  while (stack.length) { const [v, p] = stack.pop()!; for (const [w, l] of t.adj.get(v)!) if (w !== p) { dist.set(w, dist.get(v)! + l); stack.push([w, v]); } }
  return dist;
}

export type Rooting = { mode: 'unrooted' } | { mode: 'midpoint' } | { mode: 'outgroup'; taxa: number[] };
export interface Rooted { tree: Nested; rooting: string; warnings: string[] }

/** Root the unrooted tree and return a nested structure (names, lengths, bootstrap support). */
export function root(t: UTree, names: string[], support: Map<string, number> | null, rooting: Rooting): Rooted {
  const warnings: string[] = [];
  let edge: [number, number, number] | null = null; // root placed on this edge at `frac` from a
  let frac = 0.5, label = 'Unrooted (displayed from an arbitrary internal node)';
  if (rooting.mode === 'outgroup' && rooting.taxa.length) {
    const out = new Set(rooting.taxa);
    let best: { a: number; b: number; extra: number; size: number } | null = null;
    for (const [a, b] of edges(t)) for (const [p, q] of [[a, b], [b, a]] as const) {
      const side = sideOf(t, p, q);
      if (![...out].every((x) => side.includes(x))) continue;
      const extra = side.filter((x) => !out.has(x)).length;
      if (!best || extra < best.extra || (extra === best.extra && side.length < best.size)) best = { a: p, b: q, extra, size: side.length };
    }
    if (best) {
      edge = [best.a, best.b, t.adj.get(best.a)!.get(best.b)!];
      label = `Rooted on the branch leading to the outgroup (${rooting.taxa.map((i) => names[i]).join(', ')})`;
      if (best.extra > 0) warnings.push(`The outgroup is not monophyletic in this tree: ${best.extra} other taxon/taxa fall inside the smallest clade containing all outgroups, so the root is placed on that clade's branch. Review the outgroup choice.`);
    }
  } else if (rooting.mode === 'midpoint') {
    let bestD = -1, bi = 0, bj = 0;
    for (let i = 0; i < t.n; i++) { const d = patristic(t, i); for (let j = i + 1; j < t.n; j++) if (d.get(j)! > bestD) { bestD = d.get(j)!; bi = i; bj = j; } }
    // walk from bi towards bj until half of bestD is reached
    const parent = new Map<number, number>(); const st: number[] = [bi]; parent.set(bi, -1);
    while (st.length) { const v = st.pop()!; for (const w of t.adj.get(v)!.keys()) if (!parent.has(w)) { parent.set(w, v); st.push(w); } }
    const path: number[] = []; for (let v = bj; v !== -1; v = parent.get(v)!) path.push(v);
    path.reverse();
    let acc = 0;
    for (let k = 0; k + 1 < path.length; k++) { const l = t.adj.get(path[k])!.get(path[k + 1])!; if (acc + l >= bestD / 2 - 1e-12) { edge = [path[k], path[k + 1], l]; frac = l > 0 ? (bestD / 2 - acc) / l : 0.5; break; } acc += l; }
    label = 'Midpoint-rooted (the root is the midpoint of the longest path between two taxa)';
  }
  const sup = (a: number, b: number) => support?.get(splitKeyOfEdge(t, a, b));
  const build = (v: number, p: number): Nested => {
    if (v < t.n) return { name: names[v], leaf: v, length: t.adj.get(v)!.get(p) ?? 0 };
    const kids = [...t.adj.get(v)!].filter(([w]) => w !== p).map(([w]) => ({ n: build(w, v), w }));
    const node: Nested = { length: p >= 0 ? t.adj.get(v)!.get(p)! : 0, children: kids.map((k) => k.n) };
    if (p >= 0) { node.support = sup(v, p); node.splitKey = splitKeyOfEdge(t, v, p); }
    return node;
  };
  if (edge) {
    const [a, b, l] = edge;
    const left = build(a, b), right = build(b, a);
    left.length = l * frac; right.length = l * (1 - frac);
    const s = support?.get(splitKeyOfEdge(t, a, b));
    const k = splitKeyOfEdge(t, a, b);
    // the root splits one bootstrap-supported edge in two: show the value on the clade side only
    if (s !== undefined) { const target = left.children ? left : right.children ? right : null; if (target) { target.support = s; target.splitKey = k; } }
    if (left.children) { left.support = left.splitKey === k ? left.support : undefined; }
    return { tree: { length: 0, children: [left, right] }, rooting: label, warnings };
  }
  const start = [...t.adj.keys()].find((v) => v >= t.n) ?? 0;
  return { tree: build(start, -1), rooting: label, warnings };
}

export function newick(n: Nested, withSupport = true): string {
  const esc = (s: string) => s.replace(/[\s(),:;'[\]]/g, '_');
  const rec = (x: Nested, top: boolean): string => {
    const body = x.children ? `(${x.children.map((c) => rec(c, false)).join(',')})${withSupport && x.support !== undefined ? Math.round(x.support) : ''}` : esc(x.name ?? '');
    return top ? body : `${body}:${Math.max(0, x.length).toFixed(6)}`;
  };
  return rec(n, true) + ';';
}
