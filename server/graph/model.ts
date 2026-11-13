// The relationship model. Relationships are first-class, independently editable rows (many-to-many by construction): the same two records may have several
// relationships when each has its own meaning or evidence, and deleting a relationship never touches the records it connects.
import { q, tx } from '../db.ts';
import { bad, notFound, now, uid } from '../util.ts';
import { fieldByKey } from '../schema.ts';
import { BUILTIN_TYPES, CITATION_KINDS, EVIDENCE_IDS, GRAPH_KINDS, VERIFICATION, citationUrl, normalizeEvidence } from '../../shared/graph.ts';

export interface RecInfo { id: string; tableId: string; kind: string; workspaceId: string; name: string; data: Record<string, any>; subtype: string | null }
const nameCache = new Map<string, string | null>();
function nameField(tableId: string): string | null { if (!nameCache.has(tableId)) nameCache.set(tableId, fieldByKey(tableId, 'name')?.id ?? null); return nameCache.get(tableId)!; }
export const clearNameCache = () => nameCache.clear();

export function recordInfo(ids: string[]): Map<string, RecInfo> {
  const out = new Map<string, RecInfo>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 400) {
    const part = uniq.slice(i, i + 400);
    for (const r of q.all<{ id: string; table_id: string; data: string; kind: string; workspace_id: string }>(`SELECT r.id, r.table_id, r.data, t.kind, t.workspace_id FROM records r JOIN tables t ON t.id=r.table_id WHERE r.id IN (${part.map(() => '?').join(',')})`, ...part)) {
      let data: Record<string, any> = {}; try { data = JSON.parse(r.data); } catch { /* empty */ }
      const nf = nameField(r.table_id);
      out.set(r.id, { id: r.id, tableId: r.table_id, kind: r.kind, workspaceId: r.workspace_id, name: String((nf ? data[nf] : '') || r.id), data, subtype: subtypeOf(r.table_id, r.kind, data) });
    }
  }
  return out;
}
/** protein "Protein type" / chemical "Chemical type" select value (so an Enzyme or a Metabolite is drawn as such) */
function subtypeOf(tableId: string, kind: string, data: Record<string, any>): string | null {
  const key = kind === 'protein' ? 'protType' : kind === 'chemical' ? 'chemType' : null; if (!key) return null;
  const f = fieldByKey(tableId, key); if (!f) return null;
  const v = data[f.id]; return v ? String(f.options.choices?.find((c: { id: string; name: string }) => c.id === v)?.name ?? v) : null;
}
export const selectText = (tableId: string, key: string, data: Record<string, any>): string | null => {
  const f = fieldByKey(tableId, key); if (!f) return null;
  const v = data[f.id]; if (v === undefined || v === null || v === '') return null;
  return f.type === 'singleSelect' || f.type === 'status' ? String(f.options.choices?.find((c: { id: string; name: string }) => c.id === v)?.name ?? v) : String(v);
};

// ---------------------------------------------------------------- relationship types
export interface RelType { id: string; workspaceId: string; name: string; inverseName: string | null; description: string; directional: boolean; sourceKinds: string[]; targetKinds: string[]; edgeStyle: 'solid' | 'dashed' | 'dotted'; builtin: boolean; uses?: number }
const toType = (r: any): RelType => ({ id: r.id, workspaceId: r.workspace_id, name: r.name, inverseName: r.inverse_name, description: r.description, directional: !!r.directional, sourceKinds: JSON.parse(r.source_kinds), targetKinds: JSON.parse(r.target_kinds), edgeStyle: r.edge_style, builtin: !!r.builtin, uses: r.uses });
export function ensureTypes(workspaceId: string) {
  if (q.get('SELECT 1 FROM relationship_types WHERE workspace_id=? LIMIT 1', workspaceId)) return;
  tx(() => { for (const t of BUILTIN_TYPES) q.run('INSERT OR IGNORE INTO relationship_types(id,workspace_id,name,inverse_name,description,directional,source_kinds,target_kinds,edge_style,builtin,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)', uid('rty'), workspaceId, t.name, t.inverse ?? null, t.description, t.directional ? 1 : 0, JSON.stringify(t.source), JSON.stringify(t.target), t.style, now()); });
}
export function listTypes(workspaceId: string): RelType[] {
  ensureTypes(workspaceId);
  return q.all('SELECT t.*, (SELECT COUNT(*) FROM relationships r WHERE r.type_id=t.id) uses FROM relationship_types t WHERE workspace_id=? ORDER BY builtin DESC, name', workspaceId).map(toType);
}
export function typeById(id: string): RelType | undefined { const r = q.get('SELECT * FROM relationship_types WHERE id=?', id); return r ? toType(r) : undefined; }
export function createType(workspaceId: string, b: { name: string; inverseName?: string; description?: string; directional?: boolean; sourceKinds?: string[]; targetKinds?: string[]; edgeStyle?: string }): RelType {
  ensureTypes(workspaceId);
  const name = String(b.name ?? '').trim(); if (!name || name.length > 80) throw bad('Give the relationship type a name (up to 80 characters).');
  if (q.get('SELECT 1 FROM relationship_types WHERE workspace_id=? AND name=?', workspaceId, name)) throw bad(`A relationship type called “${name}” already exists.`);
  const kinds = (a: unknown) => (Array.isArray(a) ? a.map(String).filter((k) => (GRAPH_KINDS as readonly string[]).includes(k)) : []);
  const style = ['solid', 'dashed', 'dotted'].includes(String(b.edgeStyle)) ? String(b.edgeStyle) : 'solid';
  const id = uid('rty');
  q.run('INSERT INTO relationship_types(id,workspace_id,name,inverse_name,description,directional,source_kinds,target_kinds,edge_style,builtin,created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)', id, workspaceId, name, b.inverseName?.trim().slice(0, 80) || null, String(b.description ?? '').slice(0, 600), b.directional === false ? 0 : 1, JSON.stringify(kinds(b.sourceKinds)), JSON.stringify(kinds(b.targetKinds)), style, now());
  return typeById(id)!;
}
export function updateType(id: string, b: Partial<{ name: string; inverseName: string; description: string; directional: boolean; sourceKinds: string[]; targetKinds: string[]; edgeStyle: string }>): RelType {
  const t = typeById(id); if (!t) throw notFound('Relationship type not found');
  if (t.builtin) throw bad('Built-in relationship types cannot be changed. Create your own type instead.');
  const next = { ...t, ...b };
  q.run('UPDATE relationship_types SET name=?, inverse_name=?, description=?, directional=?, source_kinds=?, target_kinds=?, edge_style=? WHERE id=?', String(next.name).trim().slice(0, 80), next.inverseName ?? null, String(next.description ?? '').slice(0, 600), next.directional ? 1 : 0, JSON.stringify(next.sourceKinds ?? []), JSON.stringify(next.targetKinds ?? []), ['solid', 'dashed', 'dotted'].includes(String(next.edgeStyle)) ? next.edgeStyle : 'solid', id);
  return typeById(id)!;
}
export function deleteType(id: string) {
  const t = typeById(id); if (!t) throw notFound('Relationship type not found');
  if (t.builtin) throw bad('Built-in relationship types cannot be deleted.');
  const uses = q.get<{ n: number }>('SELECT COUNT(*) n FROM relationships WHERE type_id=?', id)!.n;
  if (uses) throw bad(`${uses} relationship(s) use this type. Change or delete them first.`);
  q.run('DELETE FROM relationship_types WHERE id=?', id);
}

// ---------------------------------------------------------------- citations and tags
export interface CitationInput { kind: string; value: string; title?: string; url?: string; note?: string; recordRef?: string }
function cleanCitation(c: CitationInput) {
  const kind = String(c.kind ?? '').toLowerCase(); let value = String(c.value ?? '').trim();
  if (!(CITATION_KINDS as readonly string[]).includes(kind)) throw bad(`Unknown citation type “${c.kind}”. Use: ${CITATION_KINDS.join(', ')}.`);
  if (!value) throw bad('A citation needs a value (a DOI, a PMID, an accession, a URL …).');
  if (kind === 'doi') { value = value.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim(); if (!/^10\.\d{4,9}\/\S+$/i.test(value)) throw bad(`“${value}” does not look like a DOI (10.xxxx/…).`); }
  if (kind === 'pmid' && !/^\d{1,9}$/.test(value)) throw bad(`“${value}” is not a PubMed ID (digits only).`);
  if (kind === 'url' && !/^https?:\/\/\S+$/i.test(value)) throw bad('A URL citation must start with http:// or https://');
  if (kind === 'record') { if (!q.get('SELECT 1 FROM records WHERE id=?', value)) throw bad('The referenced VierStation record does not exist.'); }
  return { kind, value: value.slice(0, 500), title: c.title?.slice(0, 300) || null, url: (c.url && /^https?:\/\//i.test(c.url) ? c.url : citationUrl(kind, value)) ?? null, note: c.note?.slice(0, 500) || null, record_ref: kind === 'record' ? value : (c.recordRef ?? null) };
}
export function setCitations(ownerType: 'relationship' | 'record', ownerId: string, items: CitationInput[]) {
  const clean = items.slice(0, 50).map(cleanCitation);
  q.run('DELETE FROM citations WHERE owner_type=? AND owner_id=?', ownerType, ownerId);
  for (const c of clean) q.run('INSERT INTO citations(id,owner_type,owner_id,kind,value,title,url,record_ref,note,retrieved_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', uid('cit'), ownerType, ownerId, c.kind, c.value, c.title, c.url, c.record_ref, c.note, now(), now());
}
export const citationsOf = (ownerType: 'relationship' | 'record', ownerId: string) => q.all<any>('SELECT kind, value, title, url, note, record_ref recordRef, retrieved_at retrievedAt FROM citations WHERE owner_type=? AND owner_id=? ORDER BY created_at', ownerType, ownerId);
const cleanTags = (tags: unknown): string[] => [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).trim().replace(/\s+/g, ' ')).filter((t) => t && t.length <= 60))].slice(0, 30);
export function setRecordTags(recordId: string, tags: unknown) { const t = cleanTags(tags); q.run('DELETE FROM record_tags WHERE record_id=?', recordId); for (const x of t) q.run('INSERT OR IGNORE INTO record_tags(record_id, tag) VALUES (?,?)', recordId, x); return t; }
export function tagsOfRecords(ids: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>(); const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 400) { const p = uniq.slice(i, i + 400); for (const r of q.all<{ record_id: string; tag: string }>(`SELECT record_id, tag FROM record_tags WHERE record_id IN (${p.map(() => '?').join(',')}) ORDER BY tag`, ...p)) (m.get(r.record_id) ?? m.set(r.record_id, []).get(r.record_id)!).push(r.tag); }
  return m;
}

// ---------------------------------------------------------------- relationships
export interface RelInput {
  sourceId: string; targetId: string; typeId?: string; typeName?: string; description?: string; evidenceClass?: string; verification?: string; organism?: string; conditions?: string;
  sourceDb?: string; accession?: string; directional?: boolean; citations?: CitationInput[]; tags?: string[]; allowIncompatible?: boolean; origin?: string; linkId?: number | null;
}
export interface Relationship {
  id: string; workspaceId: string; sourceId: string; targetId: string; sourceName: string; targetName: string; sourceKind: string; targetKind: string; type: { id: string; name: string; inverseName: string | null; directional: boolean; edgeStyle: string };
  directional: boolean; description: string; evidenceClass: string; verification: string; organism: string | null; conditions: string | null; sourceDb: string | null; accession: string | null; origin: string;
  tags: string[]; citations: ReturnType<typeof citationsOf>; createdAt: string; updatedAt: string; createdBy: string | null; linkId: number | null;
}
const SELECT_REL = 'SELECT r.*, t.name type_name, t.inverse_name type_inverse, t.directional type_directional, t.edge_style type_style FROM relationships r JOIN relationship_types t ON t.id=r.type_id';
function hydrate(rows: any[]): Relationship[] {
  if (!rows.length) return [];
  const info = recordInfo(rows.flatMap((r) => [r.source_id, r.target_id]));
  const ids = rows.map((r) => r.id);
  const tags = new Map<string, string[]>(); const cites = new Map<string, any[]>();
  for (let i = 0; i < ids.length; i += 400) {
    const p = ids.slice(i, i + 400), ph = p.map(() => '?').join(',');
    for (const t of q.all<{ relationship_id: string; tag: string }>(`SELECT relationship_id, tag FROM relationship_tags WHERE relationship_id IN (${ph}) ORDER BY tag`, ...p)) (tags.get(t.relationship_id) ?? tags.set(t.relationship_id, []).get(t.relationship_id)!).push(t.tag);
    for (const c of q.all<any>(`SELECT owner_id, kind, value, title, url, note, record_ref recordRef, retrieved_at retrievedAt FROM citations WHERE owner_type='relationship' AND owner_id IN (${ph}) ORDER BY created_at`, ...p)) (cites.get(c.owner_id) ?? cites.set(c.owner_id, []).get(c.owner_id)!).push(c);
  }
  return rows.map((r) => ({
    id: r.id, workspaceId: r.workspace_id, sourceId: r.source_id, targetId: r.target_id, sourceName: info.get(r.source_id)?.name ?? r.source_id, targetName: info.get(r.target_id)?.name ?? r.target_id, sourceKind: info.get(r.source_id)?.kind ?? '', targetKind: info.get(r.target_id)?.kind ?? '',
    type: { id: r.type_id, name: r.type_name, inverseName: r.type_inverse, directional: !!r.type_directional, edgeStyle: r.type_style }, directional: !!r.directional, description: r.description, evidenceClass: normalizeEvidence(r.evidence_class), verification: r.verification,
    organism: r.organism, conditions: r.conditions, sourceDb: r.source_db, accession: r.accession, origin: r.origin, tags: tags.get(r.id) ?? [], citations: (cites.get(r.id) ?? []).map(({ owner_id: _o, ...c }) => c), createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by, linkId: r.link_id,
  }));
}
export const getRelationships = (ids: string[]): Relationship[] => (ids.length ? hydrate(q.all(`${SELECT_REL} WHERE r.id IN (${ids.map(() => '?').join(',')})`, ...ids)) : []);
export function getRelationship(id: string): Relationship { const r = getRelationships([id])[0]; if (!r) throw notFound('Relationship not found'); return r; }
export const relationshipsOf = (recordId: string): Relationship[] => hydrate(q.all(`${SELECT_REL} WHERE r.source_id=? OR r.target_id=? ORDER BY r.updated_at DESC`, recordId, recordId));

/** kinds of the two ends vs. what the type was designed for; custom (empty) lists accept anything */
export function compatibility(t: RelType, sourceKind: string, targetKind: string): string | null {
  const bad1 = t.sourceKinds.length && !t.sourceKinds.includes(sourceKind), bad2 = t.targetKinds.length && !t.targetKinds.includes(targetKind);
  if (!bad1 && !bad2) return null;
  return `“${t.name}” is normally ${t.sourceKinds.length ? `from ${t.sourceKinds.join('/')}` : 'from any record'} to ${t.targetKinds.length ? t.targetKinds.join('/') : 'any record'}, but this is ${sourceKind} → ${targetKind}.`;
}

export function createRelationship(workspaceId: string, userId: string | null, b: RelInput): Relationship {
  ensureTypes(workspaceId);
  if (b.sourceId === undefined || b.targetId === undefined) throw bad('Choose the two records to relate.');
  const info = recordInfo([b.sourceId, b.targetId]);
  const s = info.get(b.sourceId), t = info.get(b.targetId);
  if (!s || !t) throw bad('One of the two records does not exist.');
  if (s.workspaceId !== workspaceId || t.workspaceId !== workspaceId) throw bad('Both records must be in this workspace.');
  let type = b.typeId ? typeById(b.typeId) : undefined;
  if (!type && b.typeName) type = listTypes(workspaceId).find((x) => x.name.toLowerCase() === b.typeName!.trim().toLowerCase()) ?? createType(workspaceId, { name: b.typeName, directional: b.directional });
  if (!type || type.workspaceId !== workspaceId) throw bad('Choose a relationship type (or type a new one).');
  const warn = compatibility(type, s.kind, t.kind);
  if (warn && !b.allowIncompatible) { const e = bad(`${warn} Create it anyway only if you are sure.`); (e as { code?: string }).code = 'incompatible'; throw e; }
  const evidence = b.evidenceClass ? (EVIDENCE_IDS.includes(normalizeEvidence(b.evidenceClass)) ? normalizeEvidence(b.evidenceClass) : 'unverified') : 'unverified';
  const verification = VERIFICATION.some((v) => v.id === b.verification) ? b.verification! : 'unverified';
  const id = uid('rel'), org = b.organism?.trim().slice(0, 200) || null;
  try {
    tx(() => {
      q.run('INSERT INTO relationships(id,workspace_id,source_id,target_id,type_id,directional,description,evidence_class,verification,organism,conditions,source_db,accession,origin,link_id,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, workspaceId, b.sourceId, b.targetId, type!.id, (b.directional ?? type!.directional) ? 1 : 0, String(b.description ?? '').slice(0, 4000), evidence, verification, org, b.conditions?.trim().slice(0, 1000) || null, b.sourceDb?.slice(0, 120) || null, b.accession?.slice(0, 120) || null, b.origin ?? 'user', b.linkId ?? null, now(), now(), userId);
      if (b.citations?.length) setCitations('relationship', id, b.citations);
      for (const tag of cleanTags(b.tags)) q.run('INSERT OR IGNORE INTO relationship_tags(relationship_id, tag) VALUES (?,?)', id, tag);
    });
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) throw bad(`“${s.name} – ${type.name} – ${t.name}” is already recorded with the same evidence class${org ? ` and organism (${org})` : ''}. Edit that relationship, or choose a different evidence class if it is a different finding.`);
    throw e;
  }
  return getRelationship(id);
}
export function updateRelationship(id: string, b: Partial<RelInput>): Relationship {
  const cur = getRelationship(id);
  const sets: string[] = [], args: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => { sets.push(`${col}=?`); args.push(v); };
  if (b.typeId) { if (!typeById(b.typeId)) throw bad('Unknown relationship type'); set('type_id', b.typeId); }
  if (b.description !== undefined) set('description', String(b.description).slice(0, 4000));
  if (b.evidenceClass !== undefined) set('evidence_class', normalizeEvidence(b.evidenceClass));
  if (b.verification !== undefined) { if (!VERIFICATION.some((v) => v.id === b.verification)) throw bad('Unknown verification status'); set('verification', b.verification); }
  if (b.organism !== undefined) set('organism', b.organism?.trim() || null);
  if (b.conditions !== undefined) set('conditions', b.conditions?.trim() || null);
  if (b.sourceDb !== undefined) set('source_db', b.sourceDb?.trim() || null);
  if (b.accession !== undefined) set('accession', b.accession?.trim() || null);
  if (b.directional !== undefined) set('directional', b.directional ? 1 : 0);
  try {
    tx(() => {
      if (sets.length) q.run(`UPDATE relationships SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...args, now(), id);
      if (b.citations) setCitations('relationship', id, b.citations);
      if (b.tags) { q.run('DELETE FROM relationship_tags WHERE relationship_id=?', id); for (const t of cleanTags(b.tags)) q.run('INSERT OR IGNORE INTO relationship_tags(relationship_id, tag) VALUES (?,?)', id, t); }
      if (!sets.length) q.run('UPDATE relationships SET updated_at=? WHERE id=?', now(), id);
    });
  } catch (e) { if (/UNIQUE/i.test(String((e as Error).message))) throw bad('Another relationship between these records already has this type, evidence class and organism.'); throw e; }
  void cur; return getRelationship(id);
}
/** Deletes ONLY the relationship (its tags and citations go with it). The two records are never touched. A relationship made from a field link also removes that link. */
export function deleteRelationship(id: string) {
  const r = q.get<{ link_id: number | null }>('SELECT link_id FROM relationships WHERE id=?', id); if (!r) throw notFound('Relationship not found');
  tx(() => { q.run("DELETE FROM citations WHERE owner_type='relationship' AND owner_id=?", id); q.run('DELETE FROM relationships WHERE id=?', id); if (r.link_id) q.run('DELETE FROM links WHERE id=?', r.link_id); });
}

export interface RelFilter { workspaceId: string; typeIds?: string[]; evidence?: string[]; tags?: string[]; organism?: string; sourceDb?: string; verification?: string; q?: string; kinds?: string[]; limit?: number; offset?: number }
export function listRelationships(f: RelFilter): { rows: Relationship[]; total: number } {
  const where = ['r.workspace_id=?'], args: (string | number)[] = [f.workspaceId];
  if (f.typeIds?.length) { where.push(`r.type_id IN (${f.typeIds.map(() => '?').join(',')})`); args.push(...f.typeIds); }
  if (f.evidence?.length) { where.push(`r.evidence_class IN (${f.evidence.map(() => '?').join(',')})`); args.push(...f.evidence); }
  if (f.tags?.length) { where.push(`EXISTS (SELECT 1 FROM relationship_tags x WHERE x.relationship_id=r.id AND x.tag IN (${f.tags.map(() => '?').join(',')}))`); args.push(...f.tags); }
  if (f.organism) { where.push('r.organism LIKE ?'); args.push(`%${f.organism}%`); }
  if (f.sourceDb) { where.push('r.source_db=?'); args.push(f.sourceDb); }
  if (f.verification) { where.push('r.verification=?'); args.push(f.verification); }
  if (f.q) { // description, relationship type, or the NAME of either record
    const nm = (col: string) => `EXISTS (SELECT 1 FROM records rn JOIN fields fn ON fn.table_id=rn.table_id AND fn.key='name' WHERE rn.id=${col} AND json_extract(rn.data, '$.' || fn.id) LIKE ?)`;
    where.push(`(r.description LIKE ? OR t.name LIKE ? OR ${nm('r.source_id')} OR ${nm('r.target_id')})`); args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  }
  const total = q.get<{ n: number }>(`SELECT COUNT(*) n FROM relationships r JOIN relationship_types t ON t.id=r.type_id WHERE ${where.join(' AND ')}`, ...args)!.n;
  const rows = q.all(`${SELECT_REL} WHERE ${where.join(' AND ')} ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`, ...args, Math.min(f.limit ?? 200, 2000), f.offset ?? 0);
  return { rows: hydrate(rows), total };
}
