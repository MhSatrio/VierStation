// The reference dataset of a Sequence Lab record: the query, its close relatives and its outgroups.
// Every change creates a NEW 'dataset' operation (a version); earlier versions stay in the history.
import { bad } from '../util.ts';
import { getRaw } from '../records.ts';
import { fieldByKey } from '../schema.ts';
import { latestOp, listOps, logOp, getOp, stateOf } from './store.ts';
import type { Op } from './store.ts';
import type { TaxNode } from '../integrations/ncbi.ts';

export type Role = 'query' | 'ingroup' | 'outgroup';
export interface Member {
  id: string; label: string; accession: string | null; organism: string; taxId: number | null; role: Role; reasons: string[]; seq: string;
  region: { from: number; to: number; strand: 'plus' | 'minus' } | null; identityPct: number | null; coveragePct: number | null; bitScore: number | null; evalue: number | null;
  source: 'query' | 'blast' | 'taxon_blast' | 'manual' | 'species_name'; lineage: TaxNode[]; title?: string; flags?: string[];
}
export interface Dataset { members: Member[]; basis: { queryVersionId: string; blastOpId?: string | null; note?: string } }

export const genusOf = (organism: string) => organism.split(/\s+/)[0] ?? '';
export const rankName = (m: Pick<Member, 'lineage'>, rank: string) => m.lineage.find((l) => l.rank === rank)?.name ?? null;
export const sanitizeLabel = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'seq';
export const memberLabel = (organism: string, accession: string | null) => sanitizeLabel(`${organism || 'unknown'}${accession ? '_' + accession : ''}`);

export function recordName(recordId: string): string {
  const r = getRaw(recordId);
  const f = r ? fieldByKey(r.tableId, 'name') : undefined;
  return String((r && f ? r.data[f.id] : '') || recordId);
}
export function queryMember(recordId: string): Member {
  const name = recordName(recordId);
  const st = stateOf(recordId);
  if (!st) throw bad('This record is not in the Sequence Lab yet.');
  return { id: 'query', label: sanitizeLabel(`Query_${name}`), accession: null, organism: 'Query sequence', taxId: null, role: 'query', reasons: ['The sequence being identified (current working version)'], seq: st.head.seq.replace(/-/g, ''), region: null, identityPct: null, coveragePct: null, bitScore: null, evalue: null, source: 'query', lineage: [] };
}

export function currentDataset(recordId: string): { op: Op; dataset: Dataset } | null {
  const op = latestOp(recordId, 'dataset');
  if (!op || !op.result?.members) return null;
  return { op, dataset: op.result as Dataset };
}

/** Save a new dataset version. The query member is always refreshed from the current working sequence. */
export function saveDataset(recordId: string, userId: string | null, name: string, params: Record<string, unknown>, members: Member[], o: { automatic?: boolean; warnings?: string[]; jobId?: string | null; tool?: string; basis?: Partial<Dataset['basis']>; extra?: Record<string, unknown>; dbSource?: string | null; dbRetrievedAt?: string | null } = {}): string {
  const st = stateOf(recordId)!;
  const prev = currentDataset(recordId);
  const uniq = new Map<string, number>();
  const fixed = members.map((m) => { const n = (uniq.get(m.label) ?? 0) + 1; uniq.set(m.label, n); return n === 1 ? m : { ...m, label: `${m.label}_${n}` }; });
  const dataset: Dataset = { members: fixed, basis: { queryVersionId: st.head.id, ...(prev?.dataset.basis.blastOpId ? { blastOpId: prev.dataset.basis.blastOpId } : {}), ...o.basis } };
  return logOp(recordId, { step: 'dataset', name, inputRef: prev?.op.id ?? st.head.id, params, result: { ...dataset, ...o.extra }, tool: o.tool ?? 'VierStation', actor: userId, automatic: o.automatic ?? false, warnings: o.warnings, jobId: o.jobId ?? null, supersedes: prev?.op.id ?? null, dbSource: o.dbSource ?? null, dbRetrievedAt: o.dbRetrievedAt ?? null });
}

export type DatasetEdit =
  | { action: 'remove'; ids: string[] }
  | { action: 'set_role'; ids: string[]; role: 'ingroup' | 'outgroup' }
  | { action: 'add_candidates'; opId: string; ids: string[]; role: 'ingroup' | 'outgroup' }
  | { action: 'add_manual'; member: Member }
  | { action: 'refresh_query' };

/** Apply a user edit to the dataset → new dataset version. Returns the new op id. */
export function editDataset(recordId: string, userId: string | null, name: string, e: DatasetEdit): string {
  const cur = currentDataset(recordId);
  let members = cur?.dataset.members.slice() ?? [queryMember(recordId)];
  const qm = members.find((m) => m.role === 'query');
  if (e.action === 'remove') {
    if (e.ids.includes('query')) throw bad('The query sequence cannot be removed from its own dataset.');
    const n = members.length; members = members.filter((m) => !e.ids.includes(m.id));
    if (members.length === n) throw bad('Nothing to remove.');
  } else if (e.action === 'set_role') {
    members = members.map((m) => (e.ids.includes(m.id) && m.role !== 'query' ? { ...m, role: e.role, reasons: [...m.reasons, `Role changed to ${e.role} by the user`] } : m));
  } else if (e.action === 'add_candidates') {
    const op = getOp(e.opId);
    if (!op || op.recordId !== recordId) throw bad('Candidate list not found');
    const cands: Member[] = op.result?.candidates ?? [];
    const picked = cands.filter((c) => e.ids.includes(c.id));
    if (!picked.length) throw bad('None of the chosen candidates exist in that list.');
    for (const p of picked) {
      if (members.some((m) => m.id === p.id || (m.accession && m.accession === p.accession))) continue;
      members.push({ ...p, role: e.role, reasons: [...p.reasons, `Accepted as ${e.role} by the user`] });
    }
  } else if (e.action === 'add_manual') {
    if (members.some((m) => m.accession && m.accession === e.member.accession)) throw bad(`${e.member.accession} is already in the dataset.`);
    members.push(e.member);
  } else if (e.action === 'refresh_query') {
    /* handled below */
  }
  if (qm || e.action === 'refresh_query') members = [queryMember(recordId), ...members.filter((m) => m.role !== 'query')];
  return saveDataset(recordId, userId, name, { edit: e.action, ids: 'ids' in e ? e.ids : undefined }, members, { automatic: false });
}

export const datasetOps = (recordId: string) => listOps(recordId, { step: 'dataset' });
