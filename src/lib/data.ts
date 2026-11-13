import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { post, get } from './api.ts';
import { session, useEvent, useSession } from './store.ts';
import type { FilterGroup, RecordRow, SortSpec } from '../../shared/types.ts';

export interface QSpec { filter?: FilterGroup; sorts?: SortSpec[]; groupBy?: SortSpec | null; search?: string; viewId?: string; fieldIds?: string[] }
interface Group { key: string; label: string; count: number }
const PAGE = 200;

/**
 * Windowed record loader for the virtualized grid. Pages of 200 are fetched on demand, kept while the spec is unchanged,
 * refreshed in place (no flicker) when the server announces a change, and patched optimistically on local edits.
 */
export function useRecordPages(tableId: string, spec: QSpec, enabled = true) {
  const pages = useRef(new Map<number, RecordRow[]>());
  const inflight = useRef(new Set<number>());
  const [total, setTotal] = useState<number | null>(null);
  const [groups, setGroups] = useState<Group[] | undefined>();
  const [, bump] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const specKey = JSON.stringify({ t: tableId, s: spec });
  const gen = useRef(0);

  const fetchPage = useCallback(async (p: number, g = gen.current) => {
    if (inflight.current.has(p)) return;
    inflight.current.add(p);
    try {
      const r = await post(`/api/tables/${tableId}/query`, { ...spec, offset: p * PAGE, limit: PAGE });
      if (g !== gen.current) return;
      pages.current.set(p, r.records);
      setTotal(r.total); if (p === 0 || r.groups) setGroups(r.groups);
      setError(null);
      bump((n) => n + 1);
    } catch (e) { if (g === gen.current) setError((e as Error).message); }
    finally { inflight.current.delete(p); }
  }, [specKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    gen.current++;
    pages.current = new Map(); inflight.current = new Set();
    setTotal(null); setGroups(undefined);
    if (enabled) void fetchPage(0, gen.current);
  }, [specKey, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => {
    const loaded = [...pages.current.keys()];
    inflight.current.clear();
    const g = ++gen.current;
    // refetch what is loaded, replacing pages atomically as they arrive
    if (!loaded.length) { void fetchPage(0, g); return; }
    loaded.forEach((p) => void fetchPage(p, g));
  }, [fetchPage]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEvent('record.changed', (e) => {
    if (e.tableId !== tableId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 250);
  }, [tableId, refresh]);
  // a new/changed field (formula, lookup, link …) means every cached row is missing a column: refetch
  useEvent('schema.changed', (e) => { if (!e.tableId || e.tableId === tableId) { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(refresh, 200); } }, [tableId, refresh]);
  // links to/from this table can change when ANOTHER table's records change (lookups, inverse links)
  useEvent('record.changed', (e) => { if (e.tableId !== tableId && session.get().tables.some((t) => t.id === e.tableId)) { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(refresh, 1800); } }, [tableId, refresh]);

  const rowAt = useCallback((i: number): RecordRow | undefined => pages.current.get(Math.floor(i / PAGE))?.[i % PAGE], []);
  const ensure = useCallback((from: number, to: number) => {
    for (let p = Math.floor(Math.max(0, from) / PAGE); p <= Math.floor(Math.max(0, to) / PAGE); p++) if (!pages.current.has(p) && !inflight.current.has(p)) void fetchPage(p);
  }, [fetchPage]);
  const patchLocal = useCallback((id: string, fields: Record<string, unknown>) => {
    for (const rows of pages.current.values()) {
      const r = rows.find((x) => x.id === id);
      if (r) { r.fields = { ...r.fields, ...fields }; bump((n) => n + 1); return; }
    }
  }, []);
  const loadedRows = useCallback(() => [...pages.current.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, r]) => r), []);
  return { total, groups, rowAt, ensure, error, refresh, patchLocal, loadedRows, loading: total === null && !error };
}

/** Simple loader for the non-virtualized views (kanban, gallery, list, calendar): up to `limit` records, live-refreshed. */
export function useAllRecords(tableId: string, spec: QSpec, limit = 2000, enabled = true) {
  const [data, setData] = useState<{ records: RecordRow[]; total: number; groups?: Group[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const specKey = JSON.stringify({ t: tableId, s: spec, limit });
  const gen = useRef(0);
  const load = useCallback(() => {
    const g = ++gen.current;
    post(`/api/tables/${tableId}/query`, { ...spec, offset: 0, limit }).then((r) => { if (g === gen.current) { setData(r); setError(null); } }, (e) => { if (g === gen.current) setError(e.message); });
  }, [specKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (enabled) { setData(null); load(); } }, [specKey, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEvent('record.changed', (e) => { if (e.tableId === tableId) { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(load, 120); } }, [tableId, load]);
  useEvent('schema.changed', (e) => { if (!e.tableId || e.tableId === tableId) { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(load, 200); } }, [tableId, load]);
  const patchLocal = useCallback((id: string, fields: Record<string, unknown>) => setData((d) => (d ? { ...d, records: d.records.map((r) => (r.id === id ? { ...r, fields: { ...r.fields, ...fields } } : r)) } : d)), []);
  return { data, error, reload: load, patchLocal };
}

// ---------- workspace members (for User fields) ----------
let membersCache: { wsId: string; list: { id: string; name: string; email: string; role: string }[] } | null = null;
export function useMembers() {
  const wsId = useSession((s) => s.wsId);
  const [list, setList] = useState(membersCache && membersCache.wsId === wsId ? membersCache.list : []);
  useEffect(() => {
    if (!wsId) return;
    if (membersCache?.wsId === wsId) { setList(membersCache.list); return; }
    get(`/api/workspaces/${wsId}/members`).then((r) => { membersCache = { wsId, list: r.members }; setList(r.members); }, () => {});
  }, [wsId]);
  const byId = useMemo(() => new Map(list.map((m) => [m.id, m])), [list]);
  return { members: list, byId };
}
export const clearMembersCache = () => { membersCache = null; };
