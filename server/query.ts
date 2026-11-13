// Read path: filter / sort / group / search over a table, then hydrate only the requested page.
import { q } from './db.ts';
import type { CellValue, Field, FilterGroup, RecordRow, SortSpec, ViewConfig } from '../shared/types.ts';
import { COMPUTED_TYPES } from '../shared/types.ts';
import { buildComparator, cellText, compareKeys, isGroup, matchGroup, sortKey } from '../shared/filters.ts';
import { Hydrator, hydrateRows, tableVer, toRaw } from './records.ts';
import type { RawRow } from './records.ts';
import { listFields } from './schema.ts';
import { visibleTableIds } from './access.ts';

// ---- per-table parsed-row cache (invalidated by write version); bounded so memory stays predictable ----
const cache = new Map<string, { ver: number; rows: RawRow[] }>();
const MAX_CACHED_ROWS = 250_000;
export function tableRows(tableId: string): RawRow[] {
  const ver = tableVer(tableId);
  const hit = cache.get(tableId);
  if (hit && hit.ver === ver) { cache.delete(tableId); cache.set(tableId, hit); return hit.rows; }
  const rows = q.all<any>('SELECT * FROM records WHERE table_id=? ORDER BY rowid', tableId).map(toRaw);
  cache.delete(tableId);
  cache.set(tableId, { ver, rows });
  let total = 0;
  for (const v of cache.values()) total += v.rows.length;
  for (const k of cache.keys()) { if (total <= MAX_CACHED_ROWS || k === tableId) break; total -= cache.get(k)!.rows.length; cache.delete(k); }
  return rows;
}
export const clearQueryCache = () => cache.clear();

export interface QuerySpec {
  filter?: FilterGroup;
  sorts?: SortSpec[];
  groupBy?: SortSpec | null;
  search?: string;
  offset?: number;
  limit?: number;
  fieldIds?: string[];
  ids?: string[];
}
export interface QueryResult {
  records: RecordRow[];
  total: number;
  groups?: { key: string; label: string; count: number }[];
}

function filterFieldIds(g: FilterGroup | undefined, out = new Set<string>()): Set<string> {
  if (!g) return out;
  for (const i of g.items) { if (isGroup(i)) filterFieldIds(i, out); else out.add(i.field); }
  return out;
}

export function ftsQuery(text: string): string | null {
  const toks = text.match(/[\p{L}\p{N}_.\-]+/gu);
  if (!toks?.length) return null;
  return toks.slice(0, 8).map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');
}

export function queryRecords(tableId: string, spec: QuerySpec): QueryResult {
  const fields = listFields(tableId);
  const fmap = new Map(fields.map((f) => [f.id, f]));
  const offset = Math.max(0, spec.offset ?? 0);
  const limit = Math.min(5000, Math.max(1, spec.limit ?? 200));
  const sorts = (spec.sorts ?? []).filter((s) => fmap.has(s.field));
  const hasFilter = !!spec.filter?.items.length;
  const group = spec.groupBy && fmap.has(spec.groupBy.field) ? spec.groupBy : null;

  if (spec.ids) {
    const want = new Set(spec.ids);
    const rows = tableRows(tableId).filter((r) => want.has(r.id));
    return { records: hydrateRows(tableId, rows, spec.fieldIds), total: rows.length };
  }

  // Fast path: nothing to evaluate -> straight SQL page (no full-table parse).
  if (!hasFilter && !sorts.length && !group && !spec.search) {
    const total = q.get<{ n: number }>('SELECT COUNT(*) n FROM records WHERE table_id=?', tableId)!.n;
    const rows = q.all<any>('SELECT * FROM records WHERE table_id=? ORDER BY rowid LIMIT ? OFFSET ?', tableId, limit, offset).map(toRaw);
    return { records: hydrateRows(tableId, rows, spec.fieldIds), total };
  }

  let rows = tableRows(tableId);
  if (spec.search) {
    const fq = ftsQuery(spec.search);
    if (fq) {
      const hit = new Set(q.all<{ rid: string }>('SELECT rid FROM search WHERE tid=? AND search MATCH ?', tableId, fq).map((r) => r.rid));
      rows = rows.filter((r) => hit.has(r.id));
    } else rows = [];
  }

  // Which fields must be evaluated per row?
  const need = new Set<string>([...filterFieldIds(spec.filter), ...sorts.map((s) => s.field), ...(group ? [group.field] : [])]);
  const computed = [...need].map((id) => fmap.get(id)).filter((f): f is Field => !!f && COMPUTED_TYPES.has(f.type));
  const heavy = computed.filter((f) => f.type !== 'createdTime' && f.type !== 'lastModifiedTime' && f.type !== 'thumbnail');
  let h: Hydrator | null = null;
  if (heavy.length) { h = new Hydrator(); h.add(rows); h.warm(heavy, rows); }
  const get = (r: RawRow, fid: string): CellValue => {
    const f = fmap.get(fid);
    if (!f) return null;
    if (h && COMPUTED_TYPES.has(f.type)) return h.value(r, f);
    if (f.type === 'thumbnail') return r.id;
    if (f.type === 'createdTime') return r.createdAt;
    if (f.type === 'lastModifiedTime') return r.updatedAt;
    const v = r.data[fid];
    return v === undefined ? (f.type === 'checkbox' ? false : null) : v;
  };

  if (hasFilter) {
    const filter = spec.filter!;
    rows = rows.filter((r) => matchGroup(filter, (fid) => get(r, fid), fmap));
  }
  const total = rows.length;

  let groups: QueryResult['groups'];
  if (group || sorts.length) {
    const all: SortSpec[] = group ? [group, ...sorts.filter((s) => s.field !== group.field)] : sorts;
    // decorate-sort-undecorate: compute keys once per row
    const keys = all.map((s) => ({ s, f: fmap.get(s.field) }));
    const deco = rows.map((r) => ({ r, k: keys.map((x) => sortKey(get(r, x.s.field), x.f)) }));
    deco.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) { const c = compareKeys(a.k[i], b.k[i], keys[i].s.dir); if (c) return c; }
      return 0;
    });
    rows = deco.map((d) => d.r);
    if (group) {
      const gf = fmap.get(group.field)!;
      const order = new Map<string, { key: string; label: string; count: number }>();
      for (const r of rows) {
        const v = get(r, group.field);
        const label = Array.isArray(v) ? (v.length ? cellText(v[0], gf) : '') : cellText(v, gf);
        const key = Array.isArray(v) ? String((v[0] as any)?.id ?? v[0] ?? '') : v === null || v === undefined ? '' : String(v);
        const g = order.get(key) ?? { key, label: label || '(empty)', count: 0 };
        g.count++;
        order.set(key, g);
      }
      groups = [...order.values()];
    }
  }
  void buildComparator;
  const page = rows.slice(offset, offset + limit);
  return { records: hydrateRows(tableId, page, spec.fieldIds), total, groups };
}

export function specFromView(config: ViewConfig, extra: Partial<QuerySpec> = {}): QuerySpec {
  return { filter: config.filter, sorts: config.sorts, groupBy: config.groupBy, ...extra };
}

// ---- global search (workspace-wide, permission aware) ----
export interface SearchHit { recordId: string; tableId: string; tableName: string; kind: string; title: string; snippet: string; projectId: string | null }
export function globalSearch(userId: string, workspaceId: string, text: string, limit = 25): SearchHit[] {
  const fq = ftsQuery(text);
  if (!fq) return [];
  const visible = new Set(visibleTableIds(userId, workspaceId));
  const hits = q.all<{ rid: string; tid: string; snip: string }>(
    `SELECT rid, tid, snippet(search, 3, '[', ']', '…', 10) snip FROM search WHERE search MATCH ? AND wid=? ORDER BY rank LIMIT ?`, fq, workspaceId, limit * 4);
  const out: SearchHit[] = [];
  const h = new Hydrator();
  for (const x of hits) {
    if (!visible.has(x.tid)) continue;
    const t = q.get<{ name: string; kind: string; project_id: string | null }>('SELECT name, kind, project_id FROM tables WHERE id=?', x.tid)!;
    const raw = q.get<any>('SELECT * FROM records WHERE id=?', x.rid);
    if (!raw) continue;
    out.push({ recordId: x.rid, tableId: x.tid, tableName: t.name, kind: t.kind, title: h.display(toRaw(raw)), snippet: x.snip, projectId: t.project_id });
    if (out.length >= limit) break;
  }
  return out;
}
