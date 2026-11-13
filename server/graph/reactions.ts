// Reactions (with structured participants) and pathways (ordered / branching sets of reactions). A chemical is ONE record that can take part in any number of
// reactions and pathways; roles, stoichiometry and order live in join tables, never as text inside a record.
import { q, tx } from '../db.ts';
import { bad, notFound, uid } from '../util.ts';
import { fieldByKey } from '../schema.ts';
import { updateRecord } from '../records.ts';
import { localUser } from '../local.ts';
import { ROLE_IDS, REACTION_ROLES } from '../../shared/graph.ts';
import type { ReactionRole } from '../../shared/graph.ts';
import { recordInfo, selectText } from './model.ts';

export interface Participant { id: string; recordId: string; name: string; kind: string; subtype: string | null; role: ReactionRole; stoichiometry: number | null; note: string | null }
function kindOf(id: string): string | undefined { return q.get<{ kind: string }>('SELECT t.kind FROM records r JOIN tables t ON t.id=r.table_id WHERE r.id=?', id)?.kind; }
function requireKind(id: string, kind: string, what: string) { const k = kindOf(id); if (!k) throw notFound(`${what} not found`); if (k !== kind) throw bad(`That record is a ${k}, not a ${what.toLowerCase()}.`); }

export function participantsOf(reactionIds: string[]): Map<string, Participant[]> {
  const out = new Map<string, Participant[]>(); if (!reactionIds.length) return out;
  const rows = q.all<{ id: string; reaction_id: string; record_id: string; role: ReactionRole; stoichiometry: number | null; note: string | null }>(`SELECT * FROM reaction_participants WHERE reaction_id IN (${reactionIds.map(() => '?').join(',')}) ORDER BY rowid`, ...reactionIds);
  const info = recordInfo(rows.map((r) => r.record_id));
  for (const r of rows) (out.get(r.reaction_id) ?? out.set(r.reaction_id, []).get(r.reaction_id)!).push({ id: r.id, recordId: r.record_id, name: info.get(r.record_id)?.name ?? r.record_id, kind: info.get(r.record_id)?.kind ?? '', subtype: info.get(r.record_id)?.subtype ?? null, role: r.role, stoichiometry: r.stoichiometry, note: r.note });
  return out;
}
const coef = (p: Participant) => (p.stoichiometry && p.stoichiometry !== 1 ? `${+p.stoichiometry.toFixed(3)} ` : '');
export function equationText(parts: Participant[], reversibility: string | null): string {
  const left = parts.filter((p) => p.role === 'reactant').map((p) => `${coef(p)}${p.name}`).join(' + ');
  const right = parts.filter((p) => p.role === 'product').map((p) => `${coef(p)}${p.name}`).join(' + ');
  const arrow = /^reversible/i.test(reversibility ?? '') ? '⇌' : /^irreversible/i.test(reversibility ?? '') ? '→' : '⇢';
  return left || right ? `${left || '?'} ${arrow} ${right || '?'}` : '';
}

export interface ParticipantInput { recordId: string; role: string; stoichiometry?: number | null; note?: string }
export function setParticipants(workspaceId: string, reactionId: string, items: ParticipantInput[]): { participants: Participant[]; equation: string; warnings: string[] } {
  requireKind(reactionId, 'reaction', 'Reaction');
  const clean: ParticipantInput[] = []; const seen = new Set<string>(); const warnings: string[] = [];
  const info = recordInfo(items.map((i) => i.recordId));
  for (const it of items.slice(0, 200)) {
    if (!ROLE_IDS.includes(it.role as ReactionRole)) throw bad(`Unknown role “${it.role}”. Use: ${ROLE_IDS.join(', ')}.`);
    const rec = info.get(it.recordId); if (!rec) throw bad('A participant record does not exist.'); if (rec.workspaceId !== workspaceId) throw bad('Participants must be in this workspace.');
    if (rec.kind === 'reaction' || rec.kind === 'pathway') throw bad(`A ${rec.kind} cannot be a participant of a reaction.`);
    const st = it.stoichiometry === null || it.stoichiometry === undefined || (it.stoichiometry as unknown) === '' ? null : Number(it.stoichiometry);
    if (st !== null && !(Number.isFinite(st) && st > 0 && st <= 1000)) throw bad(`Stoichiometric coefficient of ${rec.name} must be a positive number.`);
    if ((it.role === 'enzyme') && rec.kind !== 'protein') warnings.push(`${rec.name} is a ${rec.kind}, not a protein, but is listed as an enzyme.`);
    if ((it.role === 'reactant' || it.role === 'product') && rec.kind === 'protein') warnings.push(`${rec.name} is a protein listed as a ${it.role}. Use the roles enzyme/catalyst for proteins that catalyse the reaction.`);
    const key = `${it.recordId}|${it.role}`; if (seen.has(key)) continue; seen.add(key);
    clean.push({ recordId: it.recordId, role: it.role, stoichiometry: st, note: it.note?.slice(0, 300) });
  }
  if (!clean.some((c) => c.role === 'reactant') || !clean.some((c) => c.role === 'product')) warnings.push('A reaction normally has at least one reactant and one product.');
  tx(() => {
    q.run('DELETE FROM reaction_participants WHERE reaction_id=?', reactionId);
    for (const c of clean) q.run('INSERT INTO reaction_participants(id,reaction_id,record_id,role,stoichiometry,note) VALUES (?,?,?,?,?,?)', uid('rpt'), reactionId, c.recordId, c.role, c.stoichiometry ?? null, c.note ?? null);
  });
  const equation = refreshEquation(reactionId);
  return { participants: participantsOf([reactionId]).get(reactionId) ?? [], equation, warnings };
}
export function refreshEquation(reactionId: string): string {
  const parts = participantsOf([reactionId]).get(reactionId) ?? [];
  const rec = recordInfo([reactionId]).get(reactionId); if (!rec) return '';
  const eq = equationText(parts, selectText(rec.tableId, 'reversible', rec.data));
  const f = fieldByKey(rec.tableId, 'equation');
  if (f && rec.data[f.id] !== eq) updateRecord(reactionId, { [f.id]: eq }, { userId: localUser().id, origin: { jobId: 'reactions', depth: 3 } });
  return eq;
}

// ---------------------------------------------------------------- pathways
export interface StepInput { reactionId: string; label?: string; position?: number | null; branch?: string; notes?: string; orderBasis?: string }
export interface EdgeInput { from: string; to: string; kind?: string; basis?: string }
/** Replace the steps and the explicit order of a pathway. `linear` adds a "next" edge between consecutive steps in the order given – only because you asked for it. */
export function setPathwaySteps(workspaceId: string, pathwayId: string, steps: StepInput[], edges: EdgeInput[], linear = false) {
  requireKind(pathwayId, 'pathway', 'Pathway');
  const info = recordInfo([...steps.map((s) => s.reactionId), pathwayId]);
  const reactionIds: string[] = [];
  for (const s of steps.slice(0, 300)) {
    const r = info.get(s.reactionId); if (!r || r.kind !== 'reaction') throw bad('Every pathway step must be a reaction record.'); if (r.workspaceId !== workspaceId) throw bad('Reactions must be in this workspace.');
    if (reactionIds.includes(s.reactionId)) throw bad(`“${r.name}” is listed twice – a reaction can be a step of a pathway only once.`);
    reactionIds.push(s.reactionId);
  }
  const clean = [...edges];
  if (linear) for (let i = 0; i + 1 < reactionIds.length; i++) clean.push({ from: reactionIds[i], to: reactionIds[i + 1], kind: 'next', basis: 'user' });
  for (const e of clean) { if (!reactionIds.includes(e.from) || !reactionIds.includes(e.to)) throw bad('An order link must connect two steps of this pathway.'); if (e.from === e.to) throw bad('A step cannot follow itself.'); }
  tx(() => {
    q.run('DELETE FROM pathway_steps WHERE pathway_id=?', pathwayId); // edges go with the steps (ON DELETE CASCADE)
    const stepId = new Map<string, string>();
    steps.forEach((s, i) => {
      const id = uid('pst'); stepId.set(s.reactionId, id);
      q.run('INSERT INTO pathway_steps(id,pathway_id,reaction_id,label,position,branch,notes,order_basis) VALUES (?,?,?,?,?,?,?,?)', id, pathwayId, s.reactionId, s.label?.slice(0, 120) || null, s.position ?? i + 1, s.branch?.slice(0, 60) || null, s.notes?.slice(0, 600) || null, ['curated', 'user', 'unknown'].includes(String(s.orderBasis)) ? s.orderBasis! : 'unknown');
    });
    const seen = new Set<string>();
    for (const e of clean) { const k = `${e.from}>${e.to}`; if (seen.has(k)) continue; seen.add(k); q.run('INSERT INTO pathway_step_edges(id,pathway_id,from_step,to_step,kind,basis) VALUES (?,?,?,?,?,?)', uid('pse'), pathwayId, stepId.get(e.from)!, stepId.get(e.to)!, e.kind === 'alternative' ? 'alternative' : 'next', e.basis?.slice(0, 40) || 'user'); }
  });
  return buildPathway(pathwayId);
}

export interface PathwayStep { id: string; reactionId: string; reactionName: string; label: string | null; position: number | null; branch: string | null; notes: string | null; orderBasis: string; level: number; lane: number; equation: string; reversible: string | null; evidence: string | null; participants: Participant[] }
export interface PathwayView {
  pathway: { id: string; name: string; description: string | null; organism: string | null; compartment: string | null; source: string | null; evidence: string | null };
  steps: PathwayStep[]; edges: { id: string; from: string; to: string; kind: string; basis: string | null; back: boolean }[];
  orderState: 'ordered' | 'partial' | 'unknown'; hasBranches: boolean; hasCycles: boolean; chemicals: { starting: Participant[]; intermediate: Participant[]; final: Participant[] };
}
const uniqBy = <T,>(a: T[], k: (x: T) => string) => [...new Map(a.map((x) => [k(x), x])).values()];

export function buildPathway(pathwayId: string): PathwayView {
  requireKind(pathwayId, 'pathway', 'Pathway');
  const pr = recordInfo([pathwayId]).get(pathwayId)!;
  const rows = q.all<{ id: string; reaction_id: string; label: string | null; position: number | null; branch: string | null; notes: string | null; order_basis: string }>('SELECT * FROM pathway_steps WHERE pathway_id=? ORDER BY COALESCE(position, 1e9), rowid', pathwayId);
  const eRows = q.all<{ id: string; from_step: string; to_step: string; kind: string; basis: string | null }>('SELECT * FROM pathway_step_edges WHERE pathway_id=? ORDER BY rowid', pathwayId);
  const rinfo = recordInfo(rows.map((r) => r.reaction_id)); const parts = participantsOf(rows.map((r) => r.reaction_id));
  // cycle detection (depth-first); back edges are kept for display but ignored when layering
  const out = new Map<string, string[]>(); for (const e of eRows) (out.get(e.from_step) ?? out.set(e.from_step, []).get(e.from_step)!).push(e.to_step);
  const state = new Map<string, 0 | 1 | 2>(); const back = new Set<string>();
  const visit = (s: string) => { state.set(s, 1); for (const t of out.get(s) ?? []) { if (state.get(t) === 1) back.add(`${s}>${t}`); else if (!state.get(t)) visit(t); } state.set(s, 2); };
  for (const r of rows) if (!state.get(r.id)) visit(r.id);
  const fwd = eRows.filter((e) => !back.has(`${e.from_step}>${e.to_step}`));
  const level = new Map<string, number>(); const preds = new Map<string, string[]>(); for (const e of fwd) (preds.get(e.to_step) ?? preds.set(e.to_step, []).get(e.to_step)!).push(e.from_step);
  const lv = (s: string, depth = 0): number => { if (level.has(s)) return level.get(s)!; if (depth > rows.length + 2) return 0; const l = Math.max(-1, ...(preds.get(s) ?? []).map((p) => lv(p, depth + 1))) + 1; level.set(s, l); return l; };
  for (const r of rows) lv(r.id);
  const lanes = new Map<number, number>();
  const steps: PathwayStep[] = rows.map((r) => {
    const ri = rinfo.get(r.reaction_id); const l = level.get(r.id) ?? 0; const lane = lanes.get(l) ?? 0; lanes.set(l, lane + 1);
    return { id: r.id, reactionId: r.reaction_id, reactionName: ri?.name ?? r.reaction_id, label: r.label, position: r.position, branch: r.branch, notes: r.notes, orderBasis: r.order_basis, level: l, lane, equation: ri ? String(ri.data[fieldByKey(ri.tableId, 'equation')?.id ?? ''] ?? '') : '', reversible: ri ? selectText(ri.tableId, 'reversible', ri.data) : null, evidence: ri ? selectText(ri.tableId, 'evidence', ri.data) : null, participants: parts.get(r.reaction_id) ?? [] };
  });
  // weak connectivity of the explicit order decides whether the order is fully, partly or not known
  const adj = new Map<string, string[]>(); for (const e of eRows) { (adj.get(e.from_step) ?? adj.set(e.from_step, []).get(e.from_step)!).push(e.to_step); (adj.get(e.to_step) ?? adj.set(e.to_step, []).get(e.to_step)!).push(e.from_step); }
  let comps = 0; const seen = new Set<string>(); for (const r of rows) { if (seen.has(r.id)) continue; comps++; const st = [r.id]; while (st.length) { const x = st.pop()!; if (seen.has(x)) continue; seen.add(x); st.push(...(adj.get(x) ?? [])); } }
  const orderState: PathwayView['orderState'] = rows.length <= 1 ? (rows.length ? 'ordered' : 'unknown') : eRows.length === 0 ? 'unknown' : comps === 1 ? 'ordered' : 'partial';
  const consumed = steps.flatMap((s) => s.participants.filter((p) => p.role === 'reactant')), produced = steps.flatMap((s) => s.participants.filter((p) => p.role === 'product'));
  const cIds = new Set(consumed.map((p) => p.recordId)), pIds = new Set(produced.map((p) => p.recordId));
  const chem = (ids: Set<string>, src: Participant[], pred: (id: string) => boolean) => uniqBy(src.filter((p) => pred(p.recordId)), (p) => p.recordId);
  const outDeg = new Map<string, number>(); for (const e of fwd) outDeg.set(e.from_step, (outDeg.get(e.from_step) ?? 0) + 1);
  return {
    pathway: { id: pathwayId, name: pr.name, description: selectText(pr.tableId, 'description', pr.data), organism: selectText(pr.tableId, 'organism', pr.data), compartment: selectText(pr.tableId, 'compartment', pr.data), source: selectText(pr.tableId, 'source', pr.data), evidence: selectText(pr.tableId, 'evidence', pr.data) },
    steps, edges: eRows.map((e) => ({ id: e.id, from: e.from_step, to: e.to_step, kind: e.kind, basis: e.basis, back: back.has(`${e.from_step}>${e.to_step}`) })), orderState,
    hasBranches: [...outDeg.values()].some((n) => n > 1), hasCycles: back.size > 0,
    chemicals: { starting: chem(cIds, consumed, (id) => !pIds.has(id)), intermediate: chem(cIds, consumed, (id) => pIds.has(id)), final: chem(pIds, produced, (id) => !cIds.has(id)) },
  };
}

/** every pathway a record takes part in: through reactions it participates in, as a reaction itself, or by an explicit relationship to a pathway */
export function pathwaysOfRecord(recordId: string) {
  const kind = kindOf(recordId); if (!kind) throw notFound('Record not found');
  const out = new Map<string, { pathwayId: string; name: string; via: { reactionId: string; reaction: string; role: string | null }[]; linked: boolean }>();
  const add = (pid: string, via?: { reactionId: string; reaction: string; role: string | null }, linked = false) => { const e = out.get(pid) ?? { pathwayId: pid, name: '', via: [], linked: false }; if (via && !e.via.some((v) => v.reactionId === via.reactionId)) e.via.push(via); e.linked ||= linked; out.set(pid, e); };
  if (kind === 'pathway') add(recordId);
  const reactions = kind === 'reaction' ? [{ reaction_id: recordId, role: null as string | null }] : q.all<{ reaction_id: string; role: string }>('SELECT reaction_id, role FROM reaction_participants WHERE record_id=?', recordId);
  const rn = recordInfo(reactions.map((r) => r.reaction_id));
  for (const r of reactions) for (const ps of q.all<{ pathway_id: string }>('SELECT pathway_id FROM pathway_steps WHERE reaction_id=?', r.reaction_id)) add(ps.pathway_id, { reactionId: r.reaction_id, reaction: rn.get(r.reaction_id)?.name ?? r.reaction_id, role: r.role });
  for (const r of q.all<{ target_id: string; source_id: string }>('SELECT source_id, target_id FROM relationships WHERE source_id=? OR target_id=?', recordId, recordId)) { const other = r.source_id === recordId ? r.target_id : r.source_id; if (kindOf(other) === 'pathway') add(other, undefined, true); }
  const info = recordInfo([...out.keys()]);
  return [...out.values()].map((e) => ({ ...e, name: info.get(e.pathwayId)?.name ?? e.pathwayId })).sort((a, b) => a.name.localeCompare(b.name));
}
export { REACTION_ROLES };
