// Pure helpers for the explorer canvas: merging graph pages, pathway positions, view files. No DOM, no Cytoscape – unit-testable.
export interface XNode { id: string; label: string; kind: string; type: string; subtype?: string | null; tableId?: string; accession?: string | null; organism?: string | null; tags: string[]; degree: number; more: number; thumb?: boolean }
export interface XEdge { id: string; source: string; target: string; label: string; typeId: string | null; typeName: string; directional: boolean; style: string; evidence: string; predicted: boolean; verification: string; origin: 'relationship' | 'field' | 'participant' | 'step' | 'order'; role?: string; stoichiometry?: number | null; tags: string[]; citations: number; description: string; organism: string | null; sourceDb: string | null }
export interface XGraph { nodes: XNode[]; edges: XEdge[]; truncated: boolean; focus: string[]; counts: { nodes: number; edges: number }; warnings: string[] }
export interface PathView { pathway: { id: string; name: string }; steps: { id: string; reactionId: string; reactionName: string; level: number; lane: number; equation: string; reversible: string | null; evidence: string | null; orderBasis: string; branch: string | null; label: string | null; participants: { recordId: string; name: string; kind: string; role: string }[] }[]; edges: { id: string; from: string; to: string; kind: string; basis: string | null; back: boolean }[]; orderState: 'ordered' | 'partial' | 'unknown'; hasBranches: boolean; hasCycles: boolean; chemicals: { starting: { recordId: string; name: string }[]; intermediate: { recordId: string; name: string }[]; final: { recordId: string; name: string }[] } }

/** Union of two graph pages (expansion adds to what is shown; nothing already drawn is removed or moved). */
export function mergeGraphs(base: XGraph, extra: XGraph[]): XGraph {
  if (!extra.length) return base;
  const nodes = new Map(base.nodes.map((n) => [n.id, n])), edges = new Map(base.edges.map((e) => [e.id, e]));
  for (const g of extra) { for (const n of g.nodes) { const o = nodes.get(n.id); nodes.set(n.id, o ? { ...o, degree: Math.max(o.degree, n.degree), more: Math.min(o.more, n.more) } : n); } for (const e of g.edges) edges.set(e.id, e); }
  // degree/more recomputed from the merged edge set so the “+N more” badge is correct after an expansion
  const deg = new Map<string, number>(); for (const e of edges.values()) { deg.set(e.source, (deg.get(e.source) ?? 0) + 1); deg.set(e.target, (deg.get(e.target) ?? 0) + 1); }
  const total = new Map<string, number>(); for (const n of [...base.nodes, ...extra.flatMap((g) => g.nodes)]) total.set(n.id, Math.max(total.get(n.id) ?? 0, n.degree + n.more));
  const out = [...nodes.values()].map((n) => ({ ...n, degree: deg.get(n.id) ?? 0, more: Math.max(0, (total.get(n.id) ?? 0) - (deg.get(n.id) ?? 0)) }));
  return { nodes: out, edges: [...edges.values()], truncated: base.truncated || extra.some((g) => g.truncated), focus: base.focus, counts: { nodes: out.length, edges: edges.size }, warnings: [...new Set([...base.warnings, ...extra.flatMap((g) => g.warnings)])] };
}

const MODIFIERS = new Set(['enzyme', 'catalyst', 'cofactor', 'inhibitor', 'activator', 'regulator']);
/**
 * Positions for the pathway view. Reactions sit in columns by their explicit order (level) and rows by branch (lane); when the order is unknown they form a plain grid
 * (nothing implies an order). Chemicals sit between the reactions that produce and consume them; enzymes and other modifiers above their reaction.
 */
export function pathwayPositions(view: PathView, graph: XGraph): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const unordered = view.orderState === 'unknown';
  // a long ordered pathway reads top-to-bottom (reactants left, products right, enzymes at the sides); a short one left-to-right
  const vertical = !unordered && new Set(view.steps.map((s) => s.level)).size > 4;
  const DX = 330, DY = 230, VX = 640, VY = 240;
  view.steps.forEach((s, i) => pos.set(s.reactionId, unordered ? { x: (i % 4) * DX, y: Math.floor(i / 4) * DY } : vertical ? { x: s.lane * VX, y: s.level * VY } : { x: s.level * DX, y: s.lane * DY }));
  const per = new Map<string, { rid: string; role: string }[]>();
  for (const e of graph.edges) if (e.origin === 'participant' && e.role) { const rid = e.role === 'product' ? e.source : e.target, other = e.role === 'product' ? e.target : e.source; if (pos.has(rid)) (per.get(other) ?? per.set(other, []).get(other)!).push({ rid, role: e.role }); }
  const slot = new Map<string, number>();
  const nextSlot = (rid: string, side: string) => { const k = `${rid}|${side}`; const n = slot.get(k) ?? 0; slot.set(k, n + 1); return n; };
  const reactionPos = new Set(view.steps.map((s) => s.reactionId));
  for (const [id, links] of per) {
    if (pos.has(id)) continue;
    const ins = links.filter((l) => l.role === 'reactant'), outs = links.filter((l) => l.role === 'product'), mods = links.filter((l) => MODIFIERS.has(l.role));
    const avg = (ls: { rid: string }[], k: 'x' | 'y') => ls.reduce((a, l) => a + pos.get(l.rid)![k], 0) / ls.length;
    if (ins.length && outs.length) pos.set(id, vertical ? { x: avg([...ins, ...outs], 'x') + 250, y: (avg(ins, 'y') + avg(outs, 'y')) / 2 + (nextSlot(ins[0].rid, 'mid') % 3 - 1) * 12 } : { x: (avg(ins, 'x') + avg(outs, 'x')) / 2, y: avg([...ins, ...outs], 'y') + (nextSlot(ins[0].rid, 'mid') % 3 - 1) * 56 });
    else if (ins.length) { const r = pos.get(ins[0].rid)!; const n = nextSlot(ins[0].rid, 'in') - 0.5; pos.set(id, vertical ? { x: r.x - 250, y: r.y + n * 64 } : { x: r.x - 150, y: r.y + n * 64 }); }
    else if (outs.length) { const r = pos.get(outs[0].rid)!; const n = nextSlot(outs[0].rid, 'out') - 0.5; pos.set(id, vertical ? { x: r.x + 250, y: r.y + n * 64 } : { x: r.x + 150, y: r.y + n * 64 }); }
    else if (mods.length) { const r = pos.get(mods[0].rid)!; const n = nextSlot(mods[0].rid, 'mod') - 0.5; const enzyme = mods[0].role === 'enzyme' || mods[0].role === 'catalyst'; pos.set(id, vertical ? { x: r.x + (enzyme ? -500 : 500), y: r.y + n * 70 } : { x: r.x + n * 110, y: r.y - 120 }); }
  }
  // gentle de-overlap for everything that is not a reaction
  const ids = [...pos.keys()].filter((id) => !reactionPos.has(id));
  for (let round = 0; round < 25; round++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = pos.get(ids[i])!, b = pos.get(ids[j])!; const dx = b.x - a.x, dy = b.y - a.y;
      if (Math.abs(dx) < 70 && Math.abs(dy) < 52) { const push = (52 - Math.abs(dy)) / 2 + 2; if (dy >= 0) { a.y -= push; b.y += push; } else { a.y += push; b.y -= push; } moved = true; }
    }
    if (!moved) break;
  }
  let extra = 0; for (const n of graph.nodes) if (!pos.has(n.id) && n.type !== 'pathway') pos.set(n.id, { x: (extra % 6) * 140, y: -DY + Math.floor(extra++ / 6) * 70 - 200 });
  return pos;
}

export interface ViewFile { app: 'VierStation'; kind: 'explorer-view'; version: 1; savedAt: string; state: Record<string, unknown>; positions: Record<string, { x: number; y: number }> }
export function parseViewFile(text: string): ViewFile {
  let j: any; try { j = JSON.parse(text); } catch { throw new Error('This is not a VierStation view file.'); }
  if (j?.app !== 'VierStation' || j?.kind !== 'explorer-view' || typeof j.state !== 'object') throw new Error('This is not a VierStation view file.');
  return j as ViewFile;
}
