import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { get } from './api.ts';
import type { Field, TableMeta, ViewMeta } from '../../shared/types.ts';

// ---------- tiny store ----------
export function createStore<T>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (patch: Partial<T> | ((s: T) => Partial<T>)) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; subs.forEach((f) => f()); },
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  };
}
export function useStore<T, S>(store: ReturnType<typeof createStore<T>>, sel: (s: T) => S): S {
  const last = useRef<{ v: S; s: T } | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const s = store.get();
    if (last.current && last.current.s === s) return last.current.v;
    const v = sel(s);
    if (last.current && JSON.stringify(last.current.v) === JSON.stringify(v)) { last.current.s = s; return last.current.v; }
    last.current = { v, s };
    return v;
  });
}

// ---------- session ----------
export interface Session {
  ready: boolean; user: { id: string; email: string; name: string; prefs: Record<string, any> } | null;
  workspaces: { id: string; name: string; role: string }[]; wsId: string | null; projectId: string | null;
  projects: { id: string; name: string; description: string; visibility: string; level: string; deadline: string | null; status: string }[];
  tables: TableMeta[]; kinds: { kind: string; label: string }[]; network: { mode: 'auto' | 'offline'; online: boolean; offline: boolean; waitingJobs: number; checkedAt: string | null };
  unread: number; running: number; sidebarCollapsed: boolean; bootError: string | null;
  setup: { labName: string | null; dataDir: string; dataDirConfigured: string | null; termsAccepted: boolean; termsVersion: number; version: string } | null;
}
export const session = createStore<Session>({ ready: false, user: null, workspaces: [], wsId: null, projectId: null, projects: [], tables: [], kinds: [], network: { mode: 'auto', online: true, offline: false, waitingJobs: 0, checkedAt: null }, unread: 0, running: 0, sidebarCollapsed: false, bootError: null, setup: null });
export const useSession = <S,>(sel: (s: Session) => S) => useStore(session, sel);

export async function loadMe() {
  session.set({ bootError: null });
  const me = await get('/api/app/state');
  const prefs = me.user?.prefs ?? {};
  const wsId = me.workspaces.find((w: any) => w.id === prefs.activeWorkspace)?.id ?? me.workspaces[0]?.id ?? null;
  session.set({ ready: true, user: me.user, workspaces: me.workspaces, wsId, kinds: me.notificationKinds ?? [], network: me.network, setup: me.setup ?? null, sidebarCollapsed: !!prefs.sidebarCollapsed });
  applyTheme(prefs.theme ?? 'system');
  if (wsId) await refreshWorkspace(prefs.activeProject);
}
export function applyTheme(theme: 'light' | 'dark' | 'system') {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
}

export async function refreshWorkspace(preferProject?: string | null) {
  const wsId = session.get().wsId;
  if (!wsId) return;
  const [p, t, n] = await Promise.all([get(`/api/workspaces/${wsId}/projects`), get(`/api/workspaces/${wsId}/tables`), get('/api/notifications?unread=1')]);
  const cur = session.get().projectId;
  const projectId = [cur, preferProject].find((id) => id && p.projects.some((x: any) => x.id === id)) ?? p.projects[0]?.id ?? null;
  session.set({ projects: p.projects, tables: t.tables, projectId, unread: n.unread });
}
export async function refreshTables() {
  const wsId = session.get().wsId;
  if (!wsId) return;
  const t = await get(`/api/workspaces/${wsId}/tables`);
  session.set({ tables: t.tables });
}
export async function refreshUnread() {
  const n = await get('/api/notifications?unread=1').catch(() => null);
  if (n) session.set({ unread: n.unread });
}

export function tableOfKind(kind: string, s = session.get()): TableMeta | undefined {
  return s.tables.find((t) => t.projectId === s.projectId && t.kind === kind);
}

// ---------- server-sent events bus ----------
type Handler = (d: any) => void;
const handlers = new Map<string, Set<Handler>>();
let es: EventSource | null = null;
export function on(type: string, fn: Handler) {
  let set = handlers.get(type);
  if (!set) { set = new Set(); handlers.set(type, set); }
  set.add(fn);
  return () => { set!.delete(fn); };
}
export function useEvent(type: string, fn: Handler, deps: unknown[] = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => on(type, (d) => ref.current(d)), [type, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}
export function connectEvents() {
  if (es) return;
  es = new EventSource('/api/events');
  for (const type of ['record.changed', 'schema.changed', 'view.changed', 'job.changed', 'notification', 'automation.run', 'comment.added']) {
    es.addEventListener(type, (e) => { let d: any = {}; try { d = JSON.parse((e as MessageEvent).data); } catch { /* ignore */ } handlers.get(type)?.forEach((f) => f(d)); });
  }
}
export function disconnectEvents() { es?.close(); es = null; }

// ---------- table metadata cache (fields + views), invalidated by schema events ----------
export interface TableDetail { table: TableMeta & { level: string }; fields: Field[]; views: ViewMeta[]; linkedTables: { id: string; name: string; kind: string }[] }
const detailCache = new Map<string, Promise<TableDetail>>();
export function loadTable(id: string, fresh = false): Promise<TableDetail> {
  if (fresh || !detailCache.has(id)) {
    const p = get<TableDetail>(`/api/tables/${id}`);
    detailCache.set(id, p);
    p.catch(() => detailCache.delete(id));
  }
  return detailCache.get(id)!;
}
export function invalidateTable(id?: string) { if (id) detailCache.delete(id); else detailCache.clear(); }

export function useTableDetail(id: string | null) {
  const [d, setD] = useState<TableDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!id) return;
    let live = true;
    setErr(null);
    loadTable(id, tick > 0).then((x) => live && setD(x), (e) => live && (setErr(e.message), setD(null)));
    return () => { live = false; };
  }, [id, tick]);
  useEvent('schema.changed', (e) => { if (!e.tableId || e.tableId === id || !id) { invalidateTable(); setTick((t) => t + 1); } });
  useEvent('view.changed', (e) => { if (e.tableId === id) { invalidateTable(id ?? undefined); setTick((t) => t + 1); } });
  return { detail: id ? d : null, error: err, reload: () => { invalidateTable(id ?? undefined); setTick((t) => t + 1); } };
}

// ---------- toasts ----------
export interface Toast { id: number; kind: 'info' | 'ok' | 'err'; text: string; link?: { to: string; label: string } }
export const toasts = createStore<{ list: Toast[] }>({ list: [] });
let tid = 1;
export function toast(text: string, kind: Toast['kind'] = 'info', link?: Toast['link']) {
  const t = { id: tid++, kind, text, link };
  toasts.set((s) => ({ list: [...s.list, t].slice(-4) }));
  setTimeout(() => toasts.set((s) => ({ list: s.list.filter((x) => x.id !== t.id) })), kind === 'err' ? 7000 : 4500);
}

// the server tells us when the connection to the scientific databases is lost or comes back
on('network.changed', (d) => session.set({ network: d }));
