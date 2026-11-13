// Shared plumbing for scientific imports: find-or-create tables by kind, upsert records by external identifier,
// provenance, status updates and evidence-aware link merging. Discovery steps are built only from these helpers.
import { q } from './db.ts';
import { now, uid, safeJson } from './util.ts';
import type { EvidenceClass, Field, LinkMeta, SelectChoice, TableKind } from '../shared/types.ts';
import { fieldByKey, listFields } from './schema.ts';
import { createRecord, findByValue, getRaw, linkRecords, updateRecord } from './records.ts';
import { ensureProjectTable } from './templates.ts';

export interface Ctx {
  workspaceId: string;
  projectId: string | null;
  userId: string | null;
  signal?: AbortSignal;
  log: (m: string, level?: 'info' | 'warn' | 'error') => void;
  origin?: { automationId?: string; jobId?: string; depth?: number } | null;
}

/** First table of this kind in the project (created on demand from the built-in definition). */
export function tableOfKind(c: Pick<Ctx, 'workspaceId' | 'projectId'>, kind: TableKind): string {
  const row = c.projectId
    ? q.get<{ id: string }>('SELECT id FROM tables WHERE workspace_id=? AND project_id=? AND kind=? ORDER BY position, created_at LIMIT 1', c.workspaceId, c.projectId, kind)
    : q.get<{ id: string }>('SELECT id FROM tables WHERE workspace_id=? AND project_id IS NULL AND kind=? ORDER BY position, created_at LIMIT 1', c.workspaceId, kind);
  if (row) return row.id;
  return ensureProjectTable(c.workspaceId, c.projectId, kind);
}

/** Build a write payload from semantic field keys; keys with no matching field (user deleted it) are skipped silently. */
export function byKeys(tableId: string, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    const f = fieldByKey(tableId, k);
    if (f) out[f.id] = v;
  }
  return out;
}

export function valueOf(tableId: string, recordId: string, key: string): unknown {
  const f = fieldByKey(tableId, key);
  if (!f) return undefined;
  return getRaw(recordId)?.data[f.id];
}

export interface Prov { sourceDb: string; accession?: string | null; query?: string | null; url?: string | null; step?: string; note?: string | null }
export function addProvenance(recordId: string, p: Prov) {
  q.run('INSERT INTO provenance(id,record_id,source_db,accession,query,url,retrieved_at,step,note) VALUES (?,?,?,?,?,?,?,?,?)',
    uid('prv'), recordId, p.sourceDb, p.accession ?? null, p.query ?? null, p.url ?? null, now(), p.step ?? 'import', p.note ?? null);
}
export function listProvenance(recordId: string) {
  return q.all<any>('SELECT id, source_db AS sourceDb, accession, query, url, retrieved_at AS retrievedAt, step, note FROM provenance WHERE record_id=? ORDER BY retrieved_at', recordId);
}

/** Choice id for a status name ("Completed") in the table's Status field, or undefined if there is no such choice. */
export function statusChoice(tableId: string, name: string): string | undefined {
  const f = fieldByKey(tableId, 'status');
  return f?.options.choices?.find((c: SelectChoice) => c.name.toLowerCase() === name.toLowerCase())?.id;
}
export function setStatus(tableId: string, recordId: string, name: string, c: Ctx) {
  const f = fieldByKey(tableId, 'status');
  const id = statusChoice(tableId, name);
  if (!f || !id) return;
  updateRecord(recordId, { [f.id]: id }, { userId: c.userId, origin: c.origin ?? { jobId: 'system', depth: 1 } });
}

export interface UpsertResult { id: string; created: boolean; changed: boolean }

/**
 * Create or update a record identified by the value of one key field (accession, taxid, CID ...).
 * Existing user-entered values are NOT overwritten unless `overwrite` lists the key (fill-empty-only is the default),
 * so re-running a discovery never clobbers curation.
 */
export function upsertByKey(c: Ctx, tableId: string, matchKey: string, matchValue: string, values: Record<string, unknown>, prov: Prov, o: { overwrite?: string[]; alsoMatch?: [string, string][] } = {}): UpsertResult {
  const mf = fieldByKey(tableId, matchKey);
  let id = mf ? findByValue(tableId, mf.id, matchValue) : undefined;
  for (const [k, v] of o.alsoMatch ?? []) {
    if (id || !v) continue;
    const f = fieldByKey(tableId, k);
    if (f) id = findByValue(tableId, f.id, v);
  }
  if (!id) {
    const rec = createRecord(tableId, byKeys(tableId, { [matchKey]: matchValue, status: 'Completed', ...values }), { userId: c.userId, createChoices: true, origin: c.origin ?? { jobId: 'system', depth: 1 } });
    addProvenance(rec.id, prov);
    return { id: rec.id, created: true, changed: true };
  }
  const changed = fillRecord(c, tableId, id, values, prov, o.overwrite);
  return { id, created: false, changed };
}

/** Fill an existing record with fetched values: empty fields only, unless a key is listed in `overwrite`. Always logs provenance. */
export function fillRecord(c: Ctx, tableId: string, id: string, values: Record<string, unknown>, prov: Prov, overwrite: string[] = []): boolean {
  const raw = getRaw(id)!;
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    const f = fieldByKey(tableId, k);
    if (!f || v === undefined || v === null || v === '') continue;
    const cur = raw.data[f.id];
    const empty = cur === undefined || cur === null || cur === '' || (Array.isArray(cur) && !cur.length);
    if (empty || overwrite.includes(k)) patch[f.id] = v;
  }
  let changed = false;
  if (Object.keys(patch).length) {
    updateRecord(id, patch, { userId: c.userId, createChoices: true, origin: c.origin ?? { jobId: 'system', depth: 1 } });
    changed = true;
  }
  addProvenance(id, { ...prov, step: prov.step ?? 'update' });
  return changed;
}

// ---------------- evidence-aware linking ----------------
const RANK: Record<EvidenceClass, number> = {
  experimentally_verified: 5, database_annotated: 4, computationally_predicted: 3, sequence_inferred: 2, user_supplied: 1, unverified: 0,
};
const REL_PRIORITY = (m: LinkMeta) => (m.evidenceClass === 'database_annotated' ? 2 : m.evidenceClass === 'experimentally_verified' ? 1 : 0);

export interface EvidenceItem { relationType?: string; evidenceClass: EvidenceClass; evidence: string; sourceDb: string; sourceId?: string; referenceUrl?: string; details?: Record<string, unknown> }

/** Merge a new piece of evidence into a link's metadata. The strongest class wins; all items are kept in details.items. */
export function mergeMeta(existing: LinkMeta | null | undefined, item: EvidenceItem): LinkMeta {
  const items: EvidenceItem[] = [...(((existing?.details as any)?.items as EvidenceItem[]) ?? [])];
  if (!items.some((i) => i.sourceDb === item.sourceDb && i.evidence === item.evidence)) items.push(item);
  items.sort((a, b) => RANK[b.evidenceClass] - RANK[a.evidenceClass] || (b.relationType ? 1 : 0) - (a.relationType ? 1 : 0));
  const top = items[0];
  // relation type: prefer a curated mechanism annotation (e.g. "inhibitor") over a generic "ligand"
  const typed = [...items].sort((a, b) => REL_PRIORITY(b as LinkMeta) - REL_PRIORITY(a as LinkMeta)).find((i) => i.relationType);
  return {
    relationType: typed?.relationType ?? top.relationType, evidenceClass: top.evidenceClass,
    evidence: items.slice(0, 3).map((i) => i.evidence).join(' | ').slice(0, 900), sourceDb: [...new Set(items.map((i) => i.sourceDb))].join(', '),
    sourceId: top.sourceId, referenceUrl: top.referenceUrl ?? items.find((i) => i.referenceUrl)?.referenceUrl, details: { items: items.slice(0, 25) },
  };
}

export function linkWithEvidence(fieldId: string, fromId: string, toId: string, item: EvidenceItem): boolean {
  const f = q.get<{ id: string; table_id: string }>('SELECT id, table_id FROM fields WHERE id=?', fieldId);
  if (!f) return false;
  const field = listFields(f.table_id).find((x) => x.id === fieldId)!;
  const inv = field.options.inverseFieldId;
  const ex = q.get<{ meta: string | null }>('SELECT meta FROM links WHERE (field_id=? AND from_id=? AND to_id=?) OR (field_id=? AND from_id=? AND to_id=?)', fieldId, fromId, toId, inv ?? '', toId, fromId);
  const meta = mergeMeta(safeJson<LinkMeta | null>(ex?.meta ?? null, null), item);
  return linkRecords(field, fromId, toId, meta);
}

/** The relation field on `fromTable` that targets `toTable` (e.g. Genes -> Proteins). */
export function relationField(fromTable: string, toTable: string): Field | undefined {
  return listFields(fromTable).find((f) => f.type === 'relation' && f.options.targetTable === toTable);
}

/** Link two records across tables using whatever relation field exists between them; no-op (returns false) if there is none. */
export function linkByTables(fromTable: string, fromId: string, toTable: string, toId: string, item: EvidenceItem): boolean {
  const f = relationField(fromTable, toTable);
  if (!f) return false;
  return linkWithEvidence(f.id, fromId, toId, item);
}
