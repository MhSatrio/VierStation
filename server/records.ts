// Record storage, validation, links (real relations with evidence) and value hydration (formula / lookup / rollup).
import { q, tx, placeholders } from './db.ts';
import { bad, notFound, now, safeJson, uid } from './util.ts';
import type { CellValue, Field, FieldOptions, LinkMeta, RecordRow, RelationRef, SelectChoice } from '../shared/types.ts';
import { COMPUTED_TYPES } from '../shared/types.ts';
import { runFormula, parseFormula, formulaRefs } from '../shared/formula.ts';
import type { FVal } from '../shared/formula.ts';
import { getTable, requireTable } from './access.ts';
import { getField, invalidateFields, listFields, normalizeChoices } from './schema.ts';
import { cleanSeq } from '../shared/sequence.ts';
import { publish } from './events.ts';
import { cellText } from '../shared/filters.ts';

export interface RawRow { id: string; tableId: string; data: Record<string, any>; createdAt: string; updatedAt: string; createdBy: string | null }
interface DbRow { id: string; table_id: string; data: string; created_at: string; updated_at: string; created_by: string | null }
export const toRaw = (r: DbRow): RawRow => ({ id: r.id, tableId: r.table_id, data: safeJson(r.data, {}), createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by });

// ---------- change hooks (automations subscribe here) ----------
export interface ChangeEvent {
  type: 'created' | 'updated' | 'deleted';
  tableId: string; recordId: string; changed: string[];
  before: Record<string, any> | null; after: Record<string, any> | null;
  userId: string | null;
  /** set when the change was made by an automation/job – used for loop prevention */
  origin?: { automationId?: string; jobId?: string; depth?: number } | null;
}
type Hook = (e: ChangeEvent) => void;
const hooks: Hook[] = [];
export const onRecordChange = (h: Hook) => { hooks.push(h); };
function emit(e: ChangeEvent) {
  for (const h of hooks) { try { h(e); } catch (err) { console.error('[hook]', err); } }
}

// ---------- value coercion ----------
const SEQ_RE: Record<string, RegExp> = { dna: /^[ACGTUNRYKMSWBDHV\-*]*$/, rna: /^[ACGUTNRYKMSWBDHV\-*]*$/, protein: /^[A-Z*\-]*$/ };
const MAX_TEXT = 10_000, MAX_LONG = 200_000, MAX_SEQ = 20_000_000;

export function cleanUrl(s: string): string {
  const t = s.trim();
  if (!t) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { throw bad(`"${t.slice(0, 60)}" is not a valid URL`); }
  if (!['http:', 'https:', 'mailto:', 'ftp:'].includes(u.protocol)) throw bad('Only http, https, mailto and ftp links are allowed');
  return u.toString();
}

export interface CoerceCtx { workspaceId: string; createChoices?: boolean; choiceUpdates?: Map<string, SelectChoice[]> }

export function coerce(f: Field, v: unknown, cx: CoerceCtx): CellValue {
  if (v === undefined) return undefined;
  if (v === null || v === '' || (Array.isArray(v) && v.length === 0 && f.type !== 'multiSelect' && f.type !== 'attachment')) return null;
  switch (f.type) {
    case 'text': { const s = String(v); if (s.length > MAX_TEXT) throw bad(`${f.name}: text is too long (max ${MAX_TEXT} characters)`); return s; }
    case 'longtext': { const s = String(v); if (s.length > MAX_LONG) throw bad(`${f.name}: text is too long`); return s; }
    case 'url': return cleanUrl(String(v));
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
      if (!Number.isFinite(n)) throw bad(`${f.name}: "${String(v).slice(0, 40)}" is not a number`);
      const p = f.options.precision;
      return p !== undefined ? Math.round(n * 10 ** p) / 10 ** p : n;
    }
    case 'checkbox': return v === true || v === 'true' || v === 1 || v === '1';
    case 'date': {
      const t = Date.parse(String(v));
      if (Number.isNaN(t)) throw bad(`${f.name}: "${String(v).slice(0, 40)}" is not a valid date`);
      const d = new Date(t);
      return f.options.includeTime ? d.toISOString() : d.toISOString().slice(0, 10);
    }
    case 'singleSelect': case 'status': return choiceId(f, v, cx);
    case 'multiSelect': {
      const arr = Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean);
      return [...new Set(arr.map((x) => choiceId(f, x, cx)))];
    }
    case 'sequence': {
      const s = cleanSeq(String(v));
      if (s.length > MAX_SEQ) throw bad(`${f.name}: sequence is too long`);
      if (!SEQ_RE[f.options.seqType ?? 'dna'].test(s)) throw bad(`${f.name}: contains characters that are not valid for a ${f.options.seqType ?? 'dna'} sequence`);
      return s;
    }
    case 'structure': {
      if (typeof v !== 'object' || Array.isArray(v)) throw bad(`${f.name}: structure must be an object`);
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of ['source', 'id', 'uniprot', 'method', 'title', 'version', 'resolution', 'meanPlddt', 'model', 'status', 'url', 'fileUrl', 'paeUrl', 'retrievedAt', 'predicted', 'chains', 'length'] as const) if (o[k] !== undefined) out[k] = o[k];
      for (const k of ['url', 'fileUrl', 'paeUrl']) if (typeof out[k] === 'string' && !/^https:\/\//.test(out[k] as string)) delete out[k];
      if (typeof out.source !== 'string') throw bad(`${f.name}: structure needs a source`);
      return out;
    }
    case 'user': {
      const id = String(v);
      if (!q.get('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?', cx.workspaceId, id)) throw bad(`${f.name}: that person is not a member of this workspace`);
      return id;
    }
    case 'attachment': {
      const arr = Array.isArray(v) ? v : [v];
      return arr.map((x) => {
        const id = typeof x === 'string' ? x : (x as any)?.id;
        const file = q.get<{ id: string; name: string; size: number; mime: string }>('SELECT id,name,size,mime FROM files WHERE id=? AND workspace_id=?', id, cx.workspaceId);
        if (!file) throw bad(`${f.name}: unknown attachment`);
        return { id: file.id, name: file.name, size: file.size, type: file.mime };
      });
    }
    default: throw bad(`${f.name} is a computed field and cannot be edited`);
  }
}

function choiceId(f: Field, v: unknown, cx: CoerceCtx): string {
  const s = String(v).trim();
  const choices = cx.choiceUpdates?.get(f.id) ?? f.options.choices ?? [];
  const hit = choices.find((c) => c.id === s) ?? choices.find((c) => c.name.toLowerCase() === s.toLowerCase());
  if (hit) return hit.id;
  if (!cx.createChoices) throw bad(`${f.name}: "${s.slice(0, 40)}" is not one of the options`);
  const colors = ['blue', 'green', 'amber', 'red', 'sky', 'gray', 'ink'] as const;
  const c: SelectChoice = { id: uid('sel'), name: s.slice(0, 100), color: colors[choices.length % colors.length] };
  cx.choiceUpdates ??= new Map();
  cx.choiceUpdates.set(f.id, [...choices, c]);
  return c.id;
}

function persistChoiceUpdates(cx: CoerceCtx, tableId: string) {
  if (!cx.choiceUpdates?.size) return;
  for (const [fid, choices] of cx.choiceUpdates) {
    const f = getField(fid);
    q.run('UPDATE fields SET options=? WHERE id=?', JSON.stringify({ ...f.options, choices: normalizeChoices(choices, choices) }), fid);
  }
  invalidateFields(tableId);
  cx.choiceUpdates = undefined;
}

// ---------- links ----------
export interface LinkRef { id: string; meta: LinkMeta | null }

function inverseOf(f: Field): string | null { return f.options.inverseFieldId ?? null; }

/** Replace the set of links of `field` for record `fromId`. Existing metadata is kept for targets that remain. */
export function setLinks(field: Field, fromId: string, targets: { id: string; meta?: LinkMeta | null }[]) {
  const inv = inverseOf(field);
  const targetTable = field.options.targetTable!;
  const uniq = new Map<string, { id: string; meta?: LinkMeta | null }>();
  for (const t of targets) uniq.set(t.id, t);
  const ids = [...uniq.keys()];
  if (ids.length) {
    const found = q.all<{ id: string }>(`SELECT id FROM records WHERE table_id=? AND id IN (${placeholders(ids.length)})`, targetTable, ...ids);
    if (found.length !== ids.length) throw bad(`${field.name}: one or more linked records do not exist in the linked table`);
  }
  const existing = new Map<string, string | null>();
  for (const r of q.all<{ to_id: string; meta: string | null }>('SELECT to_id, meta FROM links WHERE field_id=? AND from_id=?', field.id, fromId)) existing.set(r.to_id, r.meta);
  if (inv) for (const r of q.all<{ from_id: string; meta: string | null }>('SELECT from_id, meta FROM links WHERE field_id=? AND to_id=?', inv, fromId)) existing.set(r.from_id, r.meta);
  q.run('DELETE FROM links WHERE field_id=? AND from_id=?', field.id, fromId);
  if (inv) q.run('DELETE FROM links WHERE field_id=? AND to_id=?', inv, fromId);
  for (const t of uniq.values()) {
    // A link made by hand is honestly labelled "user supplied"; evidence from databases is attached by the discovery code instead.
    const meta = t.meta ? JSON.stringify(t.meta)
      : existing.get(t.id) ?? JSON.stringify({ evidenceClass: 'user_supplied', sourceDb: 'Manual entry', evidence: 'Linked manually in VierStation' } satisfies LinkMeta);
    q.run('INSERT INTO links(field_id,from_id,to_id,meta,created_at) VALUES (?,?,?,?,?)', field.id, fromId, t.id, meta, now());
  }
}

/** Add (or update the evidence of) one link without disturbing the others. Idempotent. */
export function linkRecords(field: Field, fromId: string, toId: string, meta?: LinkMeta | null): boolean {
  const inv = inverseOf(field);
  const dup = q.get<{ id: number; meta: string | null }>('SELECT id, meta FROM links WHERE field_id=? AND from_id=? AND to_id=?', field.id, fromId, toId)
    ?? (inv ? q.get<{ id: number; meta: string | null }>('SELECT id, meta FROM links WHERE field_id=? AND from_id=? AND to_id=?', inv, toId, fromId) : undefined);
  if (dup) {
    if (meta) {
      const merged = { ...safeJson<LinkMeta>(dup.meta, {}), ...meta };
      q.run('UPDATE links SET meta=? WHERE id=?', JSON.stringify(merged), dup.id);
    }
    return false;
  }
  q.run('INSERT INTO links(field_id,from_id,to_id,meta,created_at) VALUES (?,?,?,?,?)', field.id, fromId, toId, meta ? JSON.stringify(meta) : null, now());
  return true;
}

export function unlinkRecords(field: Field, a: string, b: string) {
  const inv = inverseOf(field);
  q.run('DELETE FROM links WHERE field_id=? AND ((from_id=? AND to_id=?))', field.id, a, b);
  if (inv) q.run('DELETE FROM links WHERE field_id=? AND from_id=? AND to_id=?', inv, b, a);
  q.run('DELETE FROM links WHERE field_id=? AND from_id=? AND to_id=?', field.id, b, a);
}

// ---------- hydration ----------
const ROLLUP_NUM = new Set(['sum', 'avg', 'min', 'max']);

export class Hydrator {
  raw = new Map<string, RawRow>();
  /** fieldId -> recordId -> refs (perspective of that field, both link directions merged) */
  links = new Map<string, Map<string, LinkRef[]>>();
  private loaded = new Map<string, Set<string>>();
  private visiting = new Set<string>();
  private nameCache = new Map<string, string>();

  add(rows: RawRow[]) { for (const r of rows) this.raw.set(r.id, r); }

  loadRaw(ids: string[]) {
    const need = [...new Set(ids)].filter((i) => !this.raw.has(i));
    for (let i = 0; i < need.length; i += 400) {
      const part = need.slice(i, i + 400);
      for (const r of q.all<DbRow>(`SELECT * FROM records WHERE id IN (${placeholders(part.length)})`, ...part)) this.raw.set(r.id, toRaw(r));
    }
  }

  /** Batch-load links of relation field f for the given record ids. */
  loadLinks(f: Field, ids: string[]) {
    let map = this.links.get(f.id);
    if (!map) { map = new Map(); this.links.set(f.id, map); }
    let done = this.loaded.get(f.id);
    if (!done) { done = new Set(); this.loaded.set(f.id, done); }
    const need = ids.filter((i) => !done!.has(i));
    if (!need.length) return;
    const inv = inverseOf(f);
    for (let i = 0; i < need.length; i += 400) {
      const part = need.slice(i, i + 400);
      const ph = placeholders(part.length);
      for (const r of q.all<{ from_id: string; to_id: string; meta: string | null }>(`SELECT from_id,to_id,meta FROM links WHERE field_id=? AND from_id IN (${ph}) ORDER BY id`, f.id, ...part)) {
        push(map, r.from_id, { id: r.to_id, meta: r.meta ? safeJson(r.meta, null) : null });
      }
      if (inv) for (const r of q.all<{ from_id: string; to_id: string; meta: string | null }>(`SELECT from_id,to_id,meta FROM links WHERE field_id=? AND to_id IN (${ph}) ORDER BY id`, inv, ...part)) {
        push(map, r.to_id, { id: r.from_id, meta: r.meta ? safeJson(r.meta, null) : null });
      }
    }
    for (const i of need) done.add(i);
  }

  refs(f: Field, recordId: string): LinkRef[] {
    if (!this.loaded.get(f.id)?.has(recordId)) this.loadLinks(f, [recordId]);
    return this.links.get(f.id)?.get(recordId) ?? [];
  }

  /** Pre-fetch everything the given fields need for these rows so value() never issues per-row queries. */
  warm(fields: Field[], rows: RawRow[], depth = 0, seen = new Set<string>()) {
    if (depth > 4 || !rows.length) return;
    const ids = rows.map((r) => r.id);
    for (const f of fields) {
      const key = `${f.id}:${depth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (f.type === 'relation') {
        this.loadLinks(f, ids);
        const tids = ids.flatMap((i) => this.refs(f, i).map((r) => r.id));
        this.loadRaw(tids);
        // names of linked records come from the target's primary field
        const pf = listFields(f.options.targetTable!)[0];
        if (pf) this.warm([pf], tids.map((i) => this.raw.get(i)!).filter(Boolean), depth + 1, seen);
      } else if (f.type === 'lookup' || f.type === 'rollup') {
        const rel = safeField(f.options.relationField);
        const lf = safeField(f.options.lookupField);
        if (!rel || !lf) continue;
        this.loadLinks(rel, ids);
        const tids = ids.flatMap((i) => this.refs(rel, i).map((r) => r.id));
        this.loadRaw(tids);
        this.warm([lf], tids.map((i) => this.raw.get(i)!).filter(Boolean), depth + 1, seen);
      } else if (f.type === 'formula') {
        try {
          const names = formulaRefs(parseFormula(f.options.formula ?? ''));
          const deps = listFields(f.tableId).filter((x) => names.has(x.name) && COMPUTED_TYPES.has(x.type) && x.id !== f.id);
          this.warm(deps, rows, depth + 1, seen);
        } catch { /* invalid formula is reported at evaluation */ }
      }
    }
  }

  display(r: RawRow): string {
    const c = this.nameCache.get(r.id);
    if (c !== undefined) return c;
    const pf = listFields(r.tableId)[0];
    let name = '';
    if (pf) {
      const v = this.value(r, pf, 3);
      name = cellText(v, pf);
      if (name.length > 120) name = name.slice(0, 117) + '…';
    }
    this.nameCache.set(r.id, name || '(unnamed)');
    return name || '(unnamed)';
  }

  value(r: RawRow, f: Field, depth = 0): CellValue {
    if (depth > 6) return null;
    switch (f.type) {
      case 'createdTime': return r.createdAt;
      case 'lastModifiedTime': return r.updatedAt;
      case 'thumbnail': return r.id;
      case 'relation': {
        const out: RelationRef[] = [];
        for (const ref of this.refs(f, r.id)) {
          const t = this.raw.get(ref.id) ?? (this.loadRaw([ref.id]), this.raw.get(ref.id));
          if (t) out.push({ id: t.id, name: this.display(t), tableId: t.tableId, ...(ref.meta ? { meta: ref.meta } : {}) });
        }
        return out;
      }
      case 'lookup': case 'rollup': {
        const rel = safeField(f.options.relationField), lf = safeField(f.options.lookupField);
        if (!rel || !lf) return f.type === 'rollup' ? null : [];
        const vals: CellValue[] = [];
        for (const ref of this.refs(rel, r.id)) {
          const t = this.raw.get(ref.id) ?? (this.loadRaw([ref.id]), this.raw.get(ref.id));
          if (!t) continue;
          const v = this.value(t, lf, depth + 1);
          if (lf.type === 'relation') for (const x of (v as RelationRef[])) vals.push(x.name);
          else if (Array.isArray(v) && lf.type !== 'multiSelect' && lf.type !== 'attachment') vals.push(...v);
          else vals.push(lf.options.choices && typeof v === 'string' ? cellText(v, lf) : lf.type === 'multiSelect' ? (v as string[] ?? []).map((x) => cellText(x, lf)) : v);
        }
        const flatVals = vals.flat();
        if (f.type === 'lookup') return flatVals.filter((x) => x !== null && x !== undefined);
        return rollup(f.options.rollupFn ?? 'count', flatVals, this.refs(rel, r.id).length);
      }
      case 'formula': {
        const guard = `${r.id}:${f.id}`;
        if (this.visiting.has(guard)) return '#CYCLE';
        this.visiting.add(guard);
        try {
          const byName = new Map(listFields(f.tableId).map((x) => [x.name, x]));
          const res = runFormula(f.options.formula ?? '', {
            get: (name) => {
              const fld = byName.get(name);
              if (!fld) throw new Error(`Unknown field {${name}}`);
              const v = this.value(r, fld, depth + 1);
              return toFVal(v, fld);
            },
          });
          const v = res.value;
          return Array.isArray(v) ? v.join(', ') : v;
        } finally { this.visiting.delete(guard); }
      }
      case 'checkbox': return r.data[f.id] === true;
      default: {
        const v = r.data[f.id];
        return v === undefined ? null : v;
      }
    }
  }

  row(r: RawRow, fields: Field[]): RecordRow {
    const out: Record<string, CellValue> = {};
    for (const f of fields) {
      const v = this.value(r, f);
      if (v !== null && !(Array.isArray(v) && v.length === 0 && f.type !== 'relation' && f.type !== 'lookup' && f.type !== 'multiSelect' && f.type !== 'attachment') || f.type === 'checkbox') out[f.id] = v;
      else if (f.type === 'relation' || f.type === 'lookup') out[f.id] = [];
    }
    return { id: r.id, tableId: r.tableId, fields: out, createdAt: r.createdAt, updatedAt: r.updatedAt, createdBy: r.createdBy };
  }
}

function push(m: Map<string, LinkRef[]>, k: string, v: LinkRef) {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}
function safeField(id: string | undefined): Field | undefined {
  if (!id) return undefined;
  try { return getField(id); } catch { return undefined; }
}

function toFVal(v: CellValue, f: Field): FVal {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x ? String((x as any).name ?? (x as any).id) : (x as FVal)));
  if (typeof v === 'object') return String((v as any).name ?? (v as any).id ?? '');
  if (f.options.choices && typeof v === 'string') return cellText(v, f);
  return v as FVal;
}

function rollup(fn: string, vals: CellValue[], linkedCount: number): CellValue {
  const present = vals.filter((v) => v !== null && v !== undefined && v !== '');
  if (fn === 'countAll') return linkedCount;
  if (fn === 'count') return present.length;
  if (ROLLUP_NUM.has(fn)) {
    const nums = present.map(Number).filter((n) => !Number.isNaN(n));
    if (!nums.length) return null;
    if (fn === 'sum') return nums.reduce((a, b) => a + b, 0);
    if (fn === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
    if (fn === 'min') return Math.min(...nums);
    return Math.max(...nums);
  }
  if (fn === 'join') return present.map(String).join(', ');
  if (fn === 'unique') return [...new Set(present.map(String))].join(', ');
  if (fn === 'earliest' || fn === 'latest') {
    const ts = present.map((v) => ({ v, t: Date.parse(String(v)) })).filter((x) => !Number.isNaN(x.t));
    if (!ts.length) return null;
    ts.sort((a, b) => a.t - b.t);
    return (fn === 'earliest' ? ts[0] : ts[ts.length - 1]).v;
  }
  return null;
}

export function hydrateRows(tableId: string, rows: RawRow[], fieldIds?: string[]): RecordRow[] {
  const all = listFields(tableId);
  const fields = fieldIds ? all.filter((f) => fieldIds.includes(f.id)) : all;
  const h = new Hydrator();
  h.add(rows);
  h.warm(fields, rows);
  return rows.map((r) => h.row(r, fields));
}

// ---------- full-text index ----------
const TEXT_TYPES = new Set(['text', 'longtext', 'url', 'singleSelect', 'multiSelect', 'status']);
export function searchText(r: RawRow, fields: Field[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    if (!TEXT_TYPES.has(f.type)) continue;
    const v = r.data[f.id];
    if (v === undefined || v === null) continue;
    const t = cellText(v, f);
    if (t) parts.push(t.slice(0, 600));
  }
  return parts.join(' \n ').slice(0, 6000);
}
/** The FTS row id IS the record's rowid, so replacing an entry is O(log n) (deleting by the UNINDEXED rid column would scan the whole index). */
function indexRecord(r: RawRow, wid: string, isNew = false) {
  const rowid = q.get<{ r: number }>('SELECT rowid r FROM records WHERE id=?', r.id)?.r;
  if (rowid === undefined) return;
  if (!isNew) q.run('DELETE FROM search WHERE rowid=?', rowid);
  const t = searchText(r, listFields(r.tableId));
  if (t.trim()) q.run('INSERT INTO search(rowid,rid,tid,wid,text) VALUES (?,?,?,?,?)', rowid, r.id, r.tableId, wid, t);
}
export function reindexTable(tableId: string) {
  const t = getTable(tableId);
  tx(() => {
    q.run('DELETE FROM search WHERE tid=?', tableId);
    for (const r of q.all<DbRow>('SELECT * FROM records WHERE table_id=?', tableId)) indexRecord(toRaw(r), t.workspace_id);
  });
}

// ---------- CRUD ----------
export interface WriteOpts {
  userId: string | null;
  createChoices?: boolean;
  silent?: boolean; // do not emit change events (bulk import emits one summary)
  /** bulk paths: skip building the hydrated return value (it costs several queries per record) */
  lean?: boolean;
  origin?: ChangeEvent['origin'];
  /** accept the keys as field names as well as ids */
  byName?: boolean;
}

const tableVersion = new Map<string, number>();
export const bumpTable = (tableId: string) => tableVersion.set(tableId, (tableVersion.get(tableId) ?? 0) + 1);
export const tableVer = (tableId: string) => tableVersion.get(tableId) ?? 0;

function resolveInput(tableId: string, input: Record<string, unknown>): Map<Field, unknown> {
  const fields = listFields(tableId);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  const out = new Map<Field, unknown>();
  for (const [k, v] of Object.entries(input)) {
    const f = byId.get(k) ?? byName.get(k.toLowerCase());
    if (!f) throw bad(`Unknown field "${k.slice(0, 60)}"`);
    out.set(f, v);
  }
  return out;
}

function normalizeRelationInput(v: unknown): { id: string; meta?: LinkMeta | null }[] {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => (typeof x === 'string' ? { id: x } : { id: String((x as any)?.id ?? ''), meta: (x as any)?.meta ?? null })).filter((x) => x.id);
}

export function createRecord(tableId: string, input: Record<string, unknown>, o: WriteOpts): RecordRow {
  const t = getTable(tableId);
  const id = uid('rec');
  const ts = now();
  const cx: CoerceCtx = { workspaceId: t.workspace_id, createChoices: o.createChoices };
  const data: Record<string, any> = {};
  const rels: [Field, ReturnType<typeof normalizeRelationInput>][] = [];
  for (const [f, v] of resolveInput(tableId, input)) {
    if (f.type === 'relation') { rels.push([f, normalizeRelationInput(v)]); continue; }
    if (COMPUTED_TYPES.has(f.type)) { if (v === null || v === undefined || v === '') continue; throw bad(`${f.name} is computed and cannot be set`); }
    const c = coerce(f, v, cx);
    if (c !== undefined && c !== null) data[f.id] = c;
  }
  tx(() => {
    persistChoiceUpdates(cx, tableId);
    q.run('INSERT INTO records(id,table_id,data,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?)', id, tableId, JSON.stringify(data), ts, ts, o.userId, o.userId);
    for (const [f, targets] of rels) setLinks(f, id, targets);
    indexRecord({ id, tableId, data, createdAt: ts, updatedAt: ts, createdBy: o.userId }, t.workspace_id, true);
  });
  bumpTable(tableId);
  if (o.lean) return { id, tableId, fields: {}, createdAt: ts, updatedAt: ts, createdBy: o.userId };
  const row = getRecord(id);
  if (!o.silent) {
    publish(t.workspace_id, 'record.changed', { tableId, ids: [id], op: 'created' });
    emit({ type: 'created', tableId, recordId: id, changed: Object.keys(data).concat(rels.map(([f]) => f.id)), before: null, after: { ...data }, userId: o.userId, origin: o.origin });
  }
  return row;
}

export function updateRecord(recordId: string, input: Record<string, unknown>, o: WriteOpts & { ifUnmodifiedSince?: string }): RecordRow {
  const cur = q.get<DbRow>('SELECT * FROM records WHERE id=?', recordId);
  if (!cur) throw notFound('Record not found');
  const raw = toRaw(cur);
  const t = getTable(raw.tableId);
  if (o.ifUnmodifiedSince && raw.updatedAt > o.ifUnmodifiedSince) throw bad('This record was changed by someone else. Reload and try again.');
  const cx: CoerceCtx = { workspaceId: t.workspace_id, createChoices: o.createChoices };
  const before = { ...raw.data };
  const data = { ...raw.data };
  const changed: string[] = [];
  const rels: [Field, ReturnType<typeof normalizeRelationInput>][] = [];
  for (const [f, v] of resolveInput(raw.tableId, input)) {
    if (f.type === 'relation') { rels.push([f, normalizeRelationInput(v)]); changed.push(f.id); continue; }
    if (COMPUTED_TYPES.has(f.type)) throw bad(`${f.name} is computed and cannot be edited`);
    const c = coerce(f, v, cx);
    const old = data[f.id] ?? null;
    if (JSON.stringify(old) === JSON.stringify(c ?? null)) continue;
    if (c === null || c === undefined) delete data[f.id]; else data[f.id] = c;
    changed.push(f.id);
  }
  if (!changed.length) return getRecord(recordId);
  const ts = now();
  tx(() => {
    persistChoiceUpdates(cx, raw.tableId);
    q.run('UPDATE records SET data=?, updated_at=?, updated_by=? WHERE id=?', JSON.stringify(data), ts, o.userId, recordId);
    for (const [f, targets] of rels) setLinks(f, recordId, targets);
    indexRecord({ ...raw, data, updatedAt: ts }, t.workspace_id);
  });
  bumpTable(raw.tableId);
  if (!o.silent) {
    publish(t.workspace_id, 'record.changed', { tableId: raw.tableId, ids: [recordId], op: 'updated' });
    emit({ type: 'updated', tableId: raw.tableId, recordId, changed, before, after: data, userId: o.userId, origin: o.origin });
  }
  return getRecord(recordId);
}

export function deleteRecords(tableId: string, ids: string[], o: { userId: string | null; silent?: boolean }) {
  const t = getTable(tableId);
  if (!ids.length) return 0;
  let n = 0;
  tx(() => {
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      const ph = placeholders(part.length);
      q.run(`DELETE FROM search WHERE rowid IN (SELECT rowid FROM records WHERE id IN (${ph}))`, ...part);
      n += Number(q.run(`DELETE FROM records WHERE table_id=? AND id IN (${ph})`, tableId, ...part).changes);
    }
  });
  bumpTable(tableId);
  if (!o.silent) {
    publish(t.workspace_id, 'record.changed', { tableId, ids, op: 'deleted' });
    for (const id of ids) emit({ type: 'deleted', tableId, recordId: id, changed: [], before: null, after: null, userId: o.userId });
  }
  return n;
}

export function getRecord(id: string, fieldIds?: string[]): RecordRow {
  const r = q.get<DbRow>('SELECT * FROM records WHERE id=?', id);
  if (!r) throw notFound('Record not found');
  return hydrateRows(r.table_id, [toRaw(r)], fieldIds)[0];
}
export function getRaw(id: string): RawRow | undefined {
  const r = q.get<DbRow>('SELECT * FROM records WHERE id=?', id);
  return r ? toRaw(r) : undefined;
}

/** Find a record by the value of a stored field (e.g. accession). Used for duplicate prevention. */
export function findByValue(tableId: string, fieldId: string, value: string): string | undefined {
  return q.get<{ id: string }>(`SELECT id FROM records WHERE table_id=? AND json_extract(data, ?) = ? COLLATE NOCASE LIMIT 1`, tableId, `$."${fieldId}"`, value)?.id;
}

export function recordCount(tableId: string): number {
  return q.get<{ n: number }>('SELECT COUNT(*) n FROM records WHERE table_id=?', tableId)!.n;
}

/** Records the user may open: verify the record's table permission. */
export function readableRecord(userId: string, id: string): RecordRow {
  const r = q.get<DbRow>('SELECT table_id FROM records WHERE id=?', id);
  if (!r) throw notFound('Record not found');
  requireTable(userId, r.table_id, 'viewer');
  return getRecord(id);
}

export type { FieldOptions };
