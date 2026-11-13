// The explorer's read side: neighbourhood-based graph retrieval (never "load everything"), facets for the filters, and graph exports.
// Edges come from four honest sources: stored relationships, legacy field links (shown read-only until converted), reaction participants and pathway steps/order.
import { q } from '../db.ts';
import { GRAPH_KINDS, isPredicted, normalizeEvidence, nodeTypeOf, REACTION_ROLES } from '../../shared/graph.ts';
import type { NodeTypeId } from '../../shared/graph.ts';
import { recordInfo, selectText, tagsOfRecords, citationsOf } from './model.ts';

export interface GraphQuery { workspaceId: string; focus?: string[]; depth?: number; kinds?: string[]; types?: string[]; evidence?: string[]; tags?: string[]; organism?: string; sourceDb?: string; verification?: string; pathway?: string; includeOrder?: boolean; limit?: number; tableId?: string }
export interface GNode { id: string; label: string; kind: string; type: NodeTypeId; subtype: string | null; tableId: string; accession: string | null; organism: string | null; tags: string[]; degree: number; more: number; thumb: boolean }
export interface GEdge { id: string; source: string; target: string; label: string; typeId: string | null; typeName: string; directional: boolean; style: string; evidence: string; predicted: boolean; verification: string; origin: 'relationship' | 'field' | 'participant' | 'step' | 'order'; role?: string; stoichiometry?: number | null; tags: string[]; citations: number; description: string; organism: string | null; sourceDb: string | null }
export interface GraphResult { nodes: GNode[]; edges: GEdge[]; truncated: boolean; focus: string[]; counts: { nodes: number; edges: number }; warnings: string[] }

const ph = (n: number) => new Array(n).fill('?').join(',');
const chunks = <T,>(a: T[], n = 300): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const ROLE_LABEL = Object.fromEntries(REACTION_ROLES.map((r) => [r.id, r.label])) as Record<string, string>;
const ROLE_EDGE: Record<string, { label: string; dir: 'in' | 'out'; style: string }> = {
  reactant: { label: 'Reactant of', dir: 'in', style: 'solid' }, product: { label: 'Produced by', dir: 'out', style: 'solid' }, catalyst: { label: 'Catalyzes', dir: 'in', style: 'solid' }, enzyme: { label: 'Catalyzes', dir: 'in', style: 'solid' },
  cofactor: { label: 'Cofactor of', dir: 'in', style: 'dotted' }, inhibitor: { label: 'Inhibits', dir: 'in', style: 'dashed' }, activator: { label: 'Activates', dir: 'in', style: 'solid' }, regulator: { label: 'Regulates', dir: 'in', style: 'dotted' },
};

interface Raw { rels: any[]; links: any[]; parts: any[]; steps: any[]; order: any[] }
function fetchEdges(f: GraphQuery, ids: string[] | null, limit: number): { raw: Raw; capped: boolean } {
  const raw: Raw = { rels: [], links: [], parts: [], steps: [], order: [] }; let capped = false;
  const sets = ids === null ? [null] : chunks(ids);
  for (const set of sets) {
    const where = ['r.workspace_id=?'], args: (string | number)[] = [f.workspaceId];
    if (set) { where.push(`(r.source_id IN (${ph(set.length)}) OR r.target_id IN (${ph(set.length)}))`); args.push(...set, ...set); }
    if (f.types?.length) { where.push(`r.type_id IN (${ph(f.types.length)})`); args.push(...f.types); }
    if (f.evidence?.length) { where.push(`r.evidence_class IN (${ph(f.evidence.length + 1)})`); args.push(...f.evidence, f.evidence.includes('computationally_predicted') ? 'sequence_inferred' : '-'); }
    if (f.sourceDb) { where.push('r.source_db=?'); args.push(f.sourceDb); }
    if (f.verification) { where.push('r.verification=?'); args.push(f.verification); }
    if (f.organism) { where.push('r.organism LIKE ?'); args.push(`%${f.organism}%`); }
    const rr = q.all(`SELECT r.*, t.name type_name, t.edge_style type_style, t.directional type_directional, t.inverse_name FROM relationships r JOIN relationship_types t ON t.id=r.type_id WHERE ${where.join(' AND ')} LIMIT ?`, ...args, limit);
    raw.rels.push(...rr); if (rr.length >= limit) capped = true;
    if (!f.types?.length && !f.sourceDb && !f.verification) {
      const lw = ['f.table_id IN (SELECT id FROM tables WHERE workspace_id=?)', 'l.id NOT IN (SELECT link_id FROM relationships WHERE link_id IS NOT NULL)'], la: (string | number)[] = [f.workspaceId];
      if (set) { lw.push(`(l.from_id IN (${ph(set.length)}) OR l.to_id IN (${ph(set.length)}))`); la.push(...set, ...set); }
      const ll = q.all(`SELECT l.id, l.from_id, l.to_id, l.meta, f.name fname FROM links l JOIN fields f ON f.id=l.field_id WHERE ${lw.join(' AND ')} LIMIT ?`, ...la, limit);
      raw.links.push(...ll); if (ll.length >= limit) capped = true;
    }
    if (f.types?.length || f.sourceDb || f.verification) continue; // reaction roles / pathway membership have no relationship type, source database or verification status: a filter on those hides them
    const pw = ['t.workspace_id=?'], pa: (string | number)[] = [f.workspaceId];
    const base = 'FROM reaction_participants p JOIN records rr ON rr.id=p.reaction_id JOIN tables t ON t.id=rr.table_id';
    if (set) { pw.push(`(p.reaction_id IN (${ph(set.length)}) OR p.record_id IN (${ph(set.length)}))`); pa.push(...set, ...set); }
    const pp = q.all(`SELECT p.* ${base} WHERE ${pw.join(' AND ')} LIMIT ?`, ...pa, limit * 2); raw.parts.push(...pp); if (pp.length >= limit * 2) capped = true;
    const sw = ['t.workspace_id=?'], sa: (string | number)[] = [f.workspaceId];
    const sbase = 'FROM pathway_steps s JOIN records pr ON pr.id=s.pathway_id JOIN tables t ON t.id=pr.table_id';
    if (set) { sw.push(`(s.pathway_id IN (${ph(set.length)}) OR s.reaction_id IN (${ph(set.length)}))`); sa.push(...set, ...set); }
    const ss = q.all(`SELECT s.* ${sbase} WHERE ${sw.join(' AND ')} LIMIT ?`, ...sa, limit); raw.steps.push(...ss); if (ss.length >= limit) capped = true;
  }
  if (f.includeOrder && raw.steps.length) {
    const pids = [...new Set(raw.steps.map((s) => s.pathway_id))];
    for (const set of chunks(pids)) raw.order.push(...q.all(`SELECT e.*, a.reaction_id from_reaction, b.reaction_id to_reaction FROM pathway_step_edges e JOIN pathway_steps a ON a.id=e.from_step JOIN pathway_steps b ON b.id=e.to_step WHERE e.pathway_id IN (${ph(set.length)})`, ...set));
  }
  return { raw, capped };
}

function parseMeta(m: string | null) { try { return m ? JSON.parse(m) : {}; } catch { return {}; } }

export function buildGraph(f: GraphQuery): GraphResult {
  const limit = Math.min(Math.max(f.limit ?? 400, 20), 3000), depth = Math.min(Math.max(f.depth ?? 1, 0), 4);
  const warnings: string[] = []; let truncated = false;
  let focus = (f.focus ?? []).filter(Boolean);
  const nodeIds = new Set<string>(focus);
  const edgeMap = new Map<string, GEdge>();
  const addRaw = (raw: Raw) => {
    const relIds = raw.rels.map((r) => r.id);
    const relTags = new Map<string, string[]>(); const relCites = new Map<string, number>();
    for (const c of chunks(relIds)) {
      for (const t of q.all<{ relationship_id: string; tag: string }>(`SELECT relationship_id, tag FROM relationship_tags WHERE relationship_id IN (${ph(c.length)})`, ...c)) (relTags.get(t.relationship_id) ?? relTags.set(t.relationship_id, []).get(t.relationship_id)!).push(t.tag);
      for (const t of q.all<{ owner_id: string; n: number }>(`SELECT owner_id, COUNT(*) n FROM citations WHERE owner_type='relationship' AND owner_id IN (${ph(c.length)}) GROUP BY owner_id`, ...c)) relCites.set(t.owner_id, t.n);
    }
    for (const r of raw.rels) {
      const ev = normalizeEvidence(r.evidence_class);
      edgeMap.set(r.id, { id: r.id, source: r.source_id, target: r.target_id, label: r.type_name, typeId: r.type_id, typeName: r.type_name, directional: !!r.directional, style: r.type_style, evidence: ev, predicted: isPredicted(ev), verification: r.verification, origin: 'relationship', tags: relTags.get(r.id) ?? [], citations: relCites.get(r.id) ?? 0, description: r.description, organism: r.organism, sourceDb: r.source_db });
    }
    for (const l of raw.links) {
      const m = parseMeta(l.meta); const ev = m.evidenceClass ? normalizeEvidence(m.evidenceClass) : 'user_supplied';
      if (f.evidence?.length && !f.evidence.includes(ev)) continue;
      const tn = String(m.relationType ?? l.fname).replace(/_/g, ' ');
      edgeMap.set(`lnk:${l.id}`, { id: `lnk:${l.id}`, source: l.from_id, target: l.to_id, label: tn, typeId: null, typeName: tn, directional: false, style: isPredicted(ev) ? 'dashed' : 'solid', evidence: ev, predicted: isPredicted(ev), verification: 'unverified', origin: 'field', tags: [], citations: m.referenceUrl ? 1 : 0, description: m.evidence ?? '', organism: null, sourceDb: m.sourceDb ?? null });
    }
    const reactionEv = new Map<string, string>();
    for (const p of raw.parts) {
      const spec = ROLE_EDGE[p.role]; if (!spec) continue;
      if (!reactionEv.has(p.reaction_id)) { const ri = recordInfo([p.reaction_id]).get(p.reaction_id); reactionEv.set(p.reaction_id, ri ? normalizeEvidence(evidenceFromLabel(selectText(ri.tableId, 'evidence', ri.data))) : 'unverified'); }
      const ev = reactionEv.get(p.reaction_id)!;
      if (f.evidence?.length && !f.evidence.includes(ev)) continue;
      const inbound = spec.dir === 'in'; // participant → reaction, or reaction → participant
      edgeMap.set(`rp:${p.id}`, { id: `rp:${p.id}`, source: inbound ? p.record_id : p.reaction_id, target: inbound ? p.reaction_id : p.record_id, label: spec.label + (p.stoichiometry && p.stoichiometry !== 1 ? ` (×${+p.stoichiometry.toFixed(3)})` : ''), typeId: null, typeName: `Reaction role: ${ROLE_LABEL[p.role]}`, directional: true, style: spec.style, evidence: ev, predicted: isPredicted(ev), verification: 'unverified', origin: 'participant', role: p.role, stoichiometry: p.stoichiometry, tags: [], citations: 0, description: p.note ?? '', organism: null, sourceDb: null });
    }
    for (const s of raw.steps) if (!f.evidence?.length || f.evidence.includes('user_supplied')) edgeMap.set(`ps:${s.id}`, { id: `ps:${s.id}`, source: s.reaction_id, target: s.pathway_id, label: s.label ? `Step: ${s.label}` : 'Step of pathway', typeId: null, typeName: 'Pathway membership', directional: true, style: 'solid', evidence: 'user_supplied', predicted: false, verification: 'unverified', origin: 'step', tags: [], citations: 0, description: s.notes ?? '', organism: null, sourceDb: null });
    for (const o of raw.order) if (!f.evidence?.length || f.evidence.includes(o.basis === 'curated' ? 'database_annotated' : 'user_supplied')) edgeMap.set(`po:${o.id}`, { id: `po:${o.id}`, source: o.from_reaction, target: o.to_reaction, label: o.kind === 'alternative' ? 'Alternative next step' : 'Then', typeId: null, typeName: 'Pathway order', directional: true, style: o.kind === 'alternative' ? 'dashed' : 'solid', evidence: o.basis === 'curated' ? 'database_annotated' : 'user_supplied', predicted: false, verification: 'unverified', origin: 'order', tags: [], citations: 0, description: '', organism: null, sourceDb: null });
  };

  if (f.pathway) { // a pathway and everything it contains: its reactions and all their participants (the order is added when asked)
    const steps = q.all<{ reaction_id: string }>('SELECT reaction_id FROM pathway_steps WHERE pathway_id=?', f.pathway).map((s) => s.reaction_id);
    focus = [...new Set([f.pathway, ...steps, ...(f.focus ?? [])])];
    const parts = steps.length ? q.all<{ record_id: string }>(`SELECT record_id FROM reaction_participants WHERE reaction_id IN (${ph(steps.length)})`, ...steps) : [];
    for (const id of [...focus, ...parts.map((p) => p.record_id)]) nodeIds.add(id);
    const { raw } = fetchEdges({ ...f, includeOrder: true }, [...nodeIds], limit * 3);
    raw.rels = raw.rels.filter((r) => nodeIds.has(r.source_id) && nodeIds.has(r.target_id)); raw.links = raw.links.filter((l) => nodeIds.has(l.from_id) && nodeIds.has(l.to_id));
    raw.parts = raw.parts.filter((p) => steps.includes(p.reaction_id)); raw.steps = raw.steps.filter((s) => s.pathway_id === f.pathway); raw.order = raw.order.filter((o) => o.pathway_id === f.pathway);
    addRaw(raw);
  } else if (focus.length) {
    let frontier = focus.slice();
    for (let lv = 0; lv < Math.max(depth, 1) && frontier.length; lv++) {
      const { raw, capped } = fetchEdges(f, frontier, limit);
      if (capped) truncated = true;
      const before = edgeMap.size; addRaw(raw);
      const next = new Set<string>();
      for (const e of [...edgeMap.values()]) for (const id of [e.source, e.target]) if (!nodeIds.has(id)) next.add(id);
      const room = limit - nodeIds.size; if (next.size > room) { truncated = true; warnings.push(`Level ${lv + 1} has ${next.size} more records; only the first ${Math.max(room, 0)} are shown. Use filters or expand a single node.`); }
      frontier = [...next].slice(0, Math.max(room, 0)); for (const id of frontier) nodeIds.add(id);
      if (edgeMap.size === before) break;
    }
  } else { // the broad network: bounded by the limit, ordered by recency; ask for a focus or filters to see more
    const { raw, capped } = fetchEdges(f, null, limit); if (capped) { truncated = true; warnings.push(`The network is larger than ${limit} relationships; showing a part of it. Pick a record and “Explore related network”, or filter by type, tag or pathway.`); }
    addRaw(raw); for (const e of edgeMap.values()) { nodeIds.add(e.source); nodeIds.add(e.target); }
  }

  // keep only edges whose ends are in the node set; resolve node info; apply kind/tag/organism filters
  const info = recordInfo([...nodeIds]); const tags = tagsOfRecords([...nodeIds]);
  let edges = [...edgeMap.values()].filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target) && info.has(e.source) && info.has(e.target));
  const kinds = new Set((f.kinds?.length ? f.kinds : GRAPH_KINDS) as string[]);
  const okKind = (id: string) => kinds.has(info.get(id)!.kind) || focus.includes(id);
  edges = edges.filter((e) => okKind(e.source) && okKind(e.target));
  if (f.tableId) { const inTable = (id: string) => info.get(id)!.tableId === f.tableId; if (!focus.length) edges = edges.filter((e) => inTable(e.source) || inTable(e.target)); }
  if (f.tags?.length) { const want = new Set(f.tags.map((t) => t.toLowerCase())); edges = edges.filter((e) => e.tags.some((t) => want.has(t.toLowerCase())) || (tags.get(e.source) ?? []).some((t) => want.has(t.toLowerCase())) || (tags.get(e.target) ?? []).some((t) => want.has(t.toLowerCase()))); }
  if (f.organism && !f.pathway) { const o = f.organism.toLowerCase(); const orgOf = (id: string) => { const r = info.get(id)!; return String(selectText(r.tableId, 'organism', r.data) ?? '').toLowerCase(); }; edges = edges.filter((e) => (e.organism ?? '').toLowerCase().includes(o) || orgOf(e.source).includes(o) || orgOf(e.target).includes(o) || e.origin === 'step' && orgOf(e.target).includes(o)); }
  if (edges.length > limit * 4) { edges = edges.slice(0, limit * 4); truncated = true; }
  const used = new Set<string>(focus.filter((id) => info.has(id)));
  for (const e of edges) { used.add(e.source); used.add(e.target); }
  const deg = new Map<string, number>(); for (const e of edges) { deg.set(e.source, (deg.get(e.source) ?? 0) + 1); deg.set(e.target, (deg.get(e.target) ?? 0) + 1); }
  const total = neighborCounts(f.workspaceId, [...used]);
  const tbl = new Map(q.all<{ id: string; name: string }>('SELECT id, name FROM tables WHERE workspace_id=?', f.workspaceId).map((t) => [t.id, t.name]));
  void tbl;
  const nodes: GNode[] = [...used].map((id) => {
    const r = info.get(id)!;
    const type = nodeTypeOf(r.kind, r.subtype ?? (enzymeIds.has(id) ? 'enzyme' : null));
    return { id, label: r.name, kind: r.kind, type, subtype: r.subtype, tableId: r.tableId, accession: selectText(r.tableId, 'accession', r.data), organism: selectText(r.tableId, 'organism', r.data), tags: tags.get(id) ?? [], degree: deg.get(id) ?? 0, more: Math.max(0, (total.get(id) ?? 0) - (deg.get(id) ?? 0)), thumb: ['chemical', 'protein', 'structure'].includes(r.kind) };
  });
  // a protein acting as enzyme/catalyst in a loaded reaction is drawn as an enzyme
  for (const e of edges) if (e.origin === 'participant' && (e.role === 'enzyme' || e.role === 'catalyst')) { const n = nodes.find((x) => x.id === e.source); if (n && n.kind === 'protein') n.type = 'enzyme'; }
  return { nodes, edges, truncated, focus, counts: { nodes: nodes.length, edges: edges.length }, warnings };
}
const enzymeIds = new Set<string>();
const evidenceFromLabel = (l: string | null): string => ({ 'experimentally verified': 'experimentally_verified', 'database annotated': 'database_annotated', 'literature reported': 'literature_reported', 'computationally predicted': 'computationally_predicted', 'user supplied': 'user_supplied' } as Record<string, string>)[(l ?? '').toLowerCase()] ?? 'unverified';

/** how many connections each record has in total (to show “+N more” on a node and let the user expand it) */
export function neighborCounts(workspaceId: string, ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (id: string, n: number) => out.set(id, (out.get(id) ?? 0) + n);
  for (const c of chunks(ids)) {
    const p = ph(c.length);
    for (const r of q.all<{ id: string; n: number }>(`SELECT id, SUM(n) n FROM (SELECT source_id id, COUNT(*) n FROM relationships WHERE source_id IN (${p}) GROUP BY source_id UNION ALL SELECT target_id, COUNT(*) FROM relationships WHERE target_id IN (${p}) GROUP BY target_id UNION ALL SELECT from_id, COUNT(*) FROM links WHERE from_id IN (${p}) AND id NOT IN (SELECT link_id FROM relationships WHERE link_id IS NOT NULL) GROUP BY from_id UNION ALL SELECT to_id, COUNT(*) FROM links WHERE to_id IN (${p}) AND id NOT IN (SELECT link_id FROM relationships WHERE link_id IS NOT NULL) GROUP BY to_id UNION ALL SELECT record_id, COUNT(*) FROM reaction_participants WHERE record_id IN (${p}) GROUP BY record_id UNION ALL SELECT reaction_id, COUNT(*) FROM reaction_participants WHERE reaction_id IN (${p}) GROUP BY reaction_id UNION ALL SELECT reaction_id, COUNT(*) FROM pathway_steps WHERE reaction_id IN (${p}) GROUP BY reaction_id UNION ALL SELECT pathway_id, COUNT(*) FROM pathway_steps WHERE pathway_id IN (${p}) GROUP BY pathway_id) GROUP BY id`, ...c, ...c, ...c, ...c, ...c, ...c, ...c, ...c)) bump(r.id, r.n);
  }
  void workspaceId; return out;
}

/** values for the filter panel (counts are for the whole workspace, not only the loaded graph) */
export function facets(workspaceId: string) {
  const kinds = q.all<{ kind: string; n: number }>(`SELECT t.kind, COUNT(*) n FROM records r JOIN tables t ON t.id=r.table_id WHERE t.workspace_id=? AND t.kind IN (${ph(GRAPH_KINDS.length)}) GROUP BY t.kind`, workspaceId, ...GRAPH_KINDS);
  const types = q.all<{ id: string; name: string; n: number }>('SELECT t.id, t.name, (SELECT COUNT(*) FROM relationships r WHERE r.type_id=t.id) n FROM relationship_types t WHERE t.workspace_id=? ORDER BY n DESC, t.name', workspaceId);
  const evidence = q.all<{ evidence_class: string; n: number }>('SELECT evidence_class, COUNT(*) n FROM relationships WHERE workspace_id=? GROUP BY evidence_class', workspaceId);
  const tags = q.all<{ tag: string; n: number }>(`SELECT tag, SUM(n) n FROM (SELECT tag, COUNT(*) n FROM relationship_tags rt JOIN relationships r ON r.id=rt.relationship_id WHERE r.workspace_id=? GROUP BY tag UNION ALL SELECT tag, COUNT(*) FROM record_tags x JOIN records rr ON rr.id=x.record_id JOIN tables t ON t.id=rr.table_id WHERE t.workspace_id=? GROUP BY tag) GROUP BY tag ORDER BY n DESC, tag LIMIT 300`, workspaceId, workspaceId);
  const organisms = q.all<{ organism: string }>("SELECT DISTINCT organism FROM relationships WHERE workspace_id=? AND organism IS NOT NULL AND organism<>'' ORDER BY organism LIMIT 200", workspaceId).map((o) => o.organism);
  const sources = q.all<{ source_db: string }>("SELECT DISTINCT source_db FROM relationships WHERE workspace_id=? AND source_db IS NOT NULL AND source_db<>'' ORDER BY source_db", workspaceId).map((o) => o.source_db);
  const pathways = q.all<{ id: string; name: string; steps: number }>("SELECT r.id, COALESCE(json_extract(r.data, '$.' || (SELECT id FROM fields f WHERE f.table_id=t.id AND f.key='name')), r.id) name, (SELECT COUNT(*) FROM pathway_steps s WHERE s.pathway_id=r.id) steps FROM records r JOIN tables t ON t.id=r.table_id WHERE t.workspace_id=? AND t.kind='pathway' ORDER BY name LIMIT 500", workspaceId);
  return { kinds, types, evidence: evidence.map((e) => ({ id: normalizeEvidence(e.evidence_class), n: e.n })), tags, organisms, sources, pathways };
}

// ---------------------------------------------------------------- exports (the same records, in formats other tools read)
const esc = (s: unknown) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
export function toGraphML(g: GraphResult): string {
  const nk = ['label', 'kind', 'type', 'accession', 'organism'], ek = ['label', 'evidence', 'origin', 'directional', 'description', 'sourceDb'];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<graphml xmlns="http://graphml.graphdrawing.org/xmlns">\n${nk.map((k) => `<key id="n_${k}" for="node" attr.name="${k}" attr.type="string"/>`).join('\n')}\n${ek.map((k) => `<key id="e_${k}" for="edge" attr.name="${k}" attr.type="string"/>`).join('\n')}\n<graph id="vierstation" edgedefault="directed">\n${g.nodes.map((n) => `<node id="${esc(n.id)}">${nk.map((k) => `<data key="n_${k}">${esc((n as any)[k])}</data>`).join('')}</node>`).join('\n')}\n${g.edges.map((e) => `<edge id="${esc(e.id)}" source="${esc(e.source)}" target="${esc(e.target)}">${ek.map((k) => `<data key="e_${k}">${esc((e as any)[k === 'label' ? 'typeName' : k])}</data>`).join('')}</edge>`).join('\n')}\n</graph>\n</graphml>\n`;
}
export function edgesCsv(g: GraphResult): string {
  const name = new Map(g.nodes.map((n) => [n.id, n.label])); const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['id', 'source', 'source_name', 'relationship', 'target', 'target_name', 'directional', 'evidence', 'verification', 'origin', 'organism', 'source_db', 'tags', 'citations', 'description'];
  return [head.join(','), ...g.edges.map((e) => [e.id, e.source, name.get(e.source), e.typeName, e.target, name.get(e.target), e.directional, e.evidence, e.verification, e.origin, e.organism, e.sourceDb, e.tags.join('; '), e.citations, e.description].map(cell).join(','))].join('\n') + '\n';
}
export function toCytoscapeJson(g: GraphResult) {
  return { format_version: '1.0', generated_by: 'VierStation', elements: { nodes: g.nodes.map((n) => ({ data: { ...n, name: n.label } })), edges: g.edges.map((e) => ({ data: { ...e, name: e.typeName, interaction: e.typeName } })) } };
}
export { citationsOf };
