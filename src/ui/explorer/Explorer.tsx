// Relationship Explorer: an interactive Cytoscape network of REAL stored records and relationships (or explicitly labelled predictions).
// Network / pathway / flow / table are four views of the same data. Nothing is created because two nodes were drawn near each other:
// a relationship exists only after the researcher confirms it in the panel (graph connector) or saves it in the structured editor.
import cytoscape from 'cytoscape';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EVIDENCE, GRAPH_KINDS, NODE_TYPES, VERIFICATION } from '../../../shared/graph.ts';
import { get, post } from '../../lib/api.ts';
import { navigate, useQueryParam } from '../../lib/router.tsx';
import { toast, useEvent, useSession } from '../../lib/store.ts';
import { Chip, Empty, MenuButton, Modal, Spinner, useDebounced } from '../common.tsx';
import { Hint, HelpTip } from '../Tip.tsx';
import { Icon } from '../icons.tsx';
import { PathwayEditor, ReactionEditor, TypesManager } from './Editors.tsx';
import { FlowView, PathwayBanner, RelTable } from './Flow.tsx';
import type { TableFilters } from './Flow.tsx';
import { EdgeInspector, NodeInspector } from './Inspector.tsx';
import { mergeGraphs, parseViewFile, pathwayPositions } from './layouts.ts';
import type { PathView, XEdge, XGraph, XNode } from './layouts.ts';
import { KIND_LABEL, RelationEditor, TargetPicker } from './RelationEditor.tsx';
import type { Pick } from './RelationEditor.tsx';
import { LineGlyph, ShapeGlyph, edgeData, stylesheet } from './style.tsx';

type Mode = 'network' | 'pathway' | 'flow' | 'table';
interface Filters extends TableFilters { kinds: string[] }
const NO_FILTERS: Filters = { kinds: [], types: [], evidence: [], tags: [], organism: '', source: '', verification: '' };
const LAYOUTS: Record<string, any> = {
  cose: { name: 'cose', animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 95, gravity: 0.35, numIter: 900, fit: true, padding: 40, randomize: true },
  concentric: { name: 'concentric', animate: false, fit: true, padding: 40, minNodeSpacing: 30, concentric: (n: any) => n.data('degree'), levelWidth: () => 2 },
  hierarchy: { name: 'breadthfirst', animate: false, fit: true, padding: 40, directed: true, spacingFactor: 1.15 },
  circle: { name: 'circle', animate: false, fit: true, padding: 40 }, grid: { name: 'grid', animate: false, fit: true, padding: 40, avoidOverlap: true },
};
const LAYOUT_LABEL: Record<string, string> = { cose: 'Force-directed', concentric: 'Concentric (by connections)', hierarchy: 'Hierarchy (direction)', circle: 'Circle', grid: 'Grid' };
const cache = new Map<string, { t: number; v: any }>();
async function cached(url: string, ttl = 15000) { const c = cache.get(url); if (c && Date.now() - c.t < ttl) return c.v; const v = await get(url); cache.set(url, { t: Date.now(), v }); if (cache.size > 80) cache.delete(cache.keys().next().value!); return v; }

export interface ExplorerProps { focus?: string[]; table?: string; embedded?: boolean; onOpenRecord?: (id: string) => void; initialMode?: Mode }

export function Explorer() {
  const focus = useQueryParam('focus'); const pw = useQueryParam('pathway');
  return <div className="page fill xpage"><ExplorerView key={`${focus ?? ''}|${pw ?? ''}`} focus={focus ? focus.split(',') : undefined} initialPathway={pw ?? undefined} onOpenRecord={(id) => navigate(`/record/${id}`)} /></div>;
}

export function ExplorerView({ focus: focusProp, table, embedded, onOpenRecord, initialMode, initialPathway }: ExplorerProps & { initialPathway?: string }) {
  const wsId = useSession((s) => s.wsId), projectId = useSession((s) => s.projectId);
  const net = useSession((s) => s.network);
  const [mode, setMode] = useState<Mode>(initialMode ?? (initialPathway ? 'pathway' : 'network'));
  const [focus, setFocus] = useState<string[]>(focusProp ?? []);
  const [depth, setDepth] = useState(focusProp?.length ? 2 : 1);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [pathwayId, setPathwayId] = useState<string | null>(initialPathway ?? null);
  const [limit, setLimit] = useState(400);
  const [layout, setLayout] = useState('cose');
  const [base, setBase] = useState<XGraph | null>(null); const [extra, setExtra] = useState<XGraph[]>([]);
  const [pathView, setPathView] = useState<PathView | null>(null);
  const [facets, setFacets] = useState<any>(null);
  const [err, setErr] = useState(''); const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [sel, setSel] = useState<{ nodes: string[]; edge: any | null }>({ nodes: [], edge: null });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [connect, setConnect] = useState(false); const [quick, setQuick] = useState(false);
  const [pending, setPending] = useState<{ a: Pick; b: Pick } | null>(null);
  const [dlg, setDlg] = useState<null | 'relation' | 'reaction' | 'pathway' | 'types'>(null);
  const [filtersOpen, setFiltersOpen] = useState(!embedded);
  const [search, setSearch] = useState(''); const dsearch = useDebounced(search.trim(), 200);
  const [found, setFound] = useState<Pick[]>([]);
  const host = useRef<HTMLDivElement>(null); const cyRef = useRef<cytoscape.Core | null>(null);
  const posCache = useRef(new Map<string, { x: number; y: number }>());
  const lastKey = useRef<string | undefined>(undefined);
  const connectRef = useRef(connect); connectRef.current = connect;

  const data = useMemo(() => (base ? mergeGraphs(base, extra) : null), [base, extra]);
  const names = useMemo(() => Object.fromEntries((data?.nodes ?? []).map((n) => [n.id, n.label])), [data]);
  const nodeById = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);

  // ---------------------------------------------------------------- load
  const query = useMemo(() => {
    if (!wsId) return ''; const p = new URLSearchParams({ workspace: wsId, depth: String(depth), limit: String(limit) });
    if (focus.length) p.set('focus', focus.join(',')); if (table && !focus.length) p.set('table', table);
    if (filters.kinds.length) p.set('kinds', filters.kinds.join(',')); if (filters.types.length) p.set('types', filters.types.join(',')); if (filters.evidence.length) p.set('evidence', filters.evidence.join(','));
    if (filters.tags.length) p.set('tags', filters.tags.join(',')); if (filters.organism) p.set('organism', filters.organism); if (filters.source) p.set('source', filters.source); if (filters.verification) p.set('verification', filters.verification);
    if (mode === 'pathway' && pathwayId) { p.set('pathway', pathwayId); p.set('order', '1'); }
    return p.toString();
  }, [wsId, depth, limit, focus, table, filters, mode, pathwayId]);
  const needsGraph = mode === 'network' || mode === 'pathway';
  useEffect(() => {
    if (!wsId || !needsGraph) return; if (mode === 'pathway' && !pathwayId) { setBase(null); return; }
    let live = true; setLoading(true);
    cached(`/api/explorer/graph?${query}`, tick ? 0 : 15000).then((g) => { if (live) { setBase(g); setExtra([]); setErr(''); } }, (e) => live && setErr(e.message)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [query, needsGraph, tick, wsId, mode, pathwayId]);
  useEffect(() => { if (mode === 'pathway' && pathwayId) get(`/api/pathways/${pathwayId}`).then(setPathView, () => setPathView(null)); else setPathView(null); }, [mode, pathwayId, tick]);
  useEffect(() => { if (wsId) get(`/api/explorer/facets?workspace=${wsId}`).then(setFacets, () => {}); }, [wsId, tick]);
  useEvent('graph.changed', () => { cache.clear(); setTick((t) => t + 1); }, []);
  useEvent('record.changed', () => { cache.clear(); }, []);
  useEffect(() => { if (!dsearch || !wsId) { setFound([]); return; } get(`/api/explorer/search?workspace=${wsId}&q=${encodeURIComponent(dsearch)}`).then((r) => setFound(r.results), () => {}); }, [dsearch, wsId]);

  // ---------------------------------------------------------------- canvas
  useEffect(() => {
    if (!needsGraph || !host.current) return;
    const cy = cytoscape({ container: host.current, elements: [], style: stylesheet(), minZoom: 0.08, maxZoom: 3.2, wheelSensitivity: 0.28, boxSelectionEnabled: true, selectionType: 'single' });
    cyRef.current = cy; (window as unknown as { __vsCy?: unknown }).__vsCy = cy; // handle for automated browser tests
    const syncSel = () => { const ns = cy.nodes(':selected').not('.ghost').map((n) => n.id()); const es = cy.edges(':selected').not('.ghostEdge'); setSel({ nodes: ns, edge: !ns.length && es.length === 1 ? es[0].data() : null }); };
    cy.on('select unselect', () => { setTimeout(syncSel, 0); });
    cy.on('dbltap', 'node', (e) => { if (!connectRef.current && !e.target.hasClass('ghost')) void expandNode(e.target.id()); });
    cy.on('dragfree', 'node', () => { cy.nodes().forEach((n) => { posCache.current.set(n.id(), { ...n.position() }); }); });
    // graph connector: drag from one node to another, then confirm in a panel (never created silently)
    let src: cytoscape.NodeSingular | null = null;
    const clearGhost = () => { cy.$('.ghost, .ghostEdge').remove(); cy.nodes('.dropok').removeClass('dropok'); cy.autoungrabify(false); src = null; };
    cy.on('tapstart', 'node', (e) => { if (!connectRef.current || e.target.hasClass('ghost')) return; src = e.target; cy.autoungrabify(true); cy.add([{ group: 'nodes', data: { id: '__ghost', label: '' }, classes: 'ghost', position: { ...e.position } }, { group: 'edges', data: { id: '__ghostE', source: src!.id(), target: '__ghost', elabel: '', color: '#4570B6', width: 2, line: 'dashed' }, classes: 'ghostEdge' }]); });
    cy.on('tapdrag', (e) => { if (!src) return; cy.getElementById('__ghost').position({ ...e.position }); const over = cy.nodes().not('.ghost').filter((n) => { const b = n.boundingBox(); return e.position.x >= b.x1 && e.position.x <= b.x2 && e.position.y >= b.y1 && e.position.y <= b.y2 && n.id() !== src!.id(); }); cy.nodes('.dropok').removeClass('dropok'); over.first().addClass('dropok'); });
    cy.on('tapend', (e) => {
      if (!src) return; const from = src; const to = cy.nodes('.dropok').first(); const hit = to.length ? to : (e.target !== cy && e.target.isNode?.() && !e.target.hasClass('ghost') && e.target.id() !== from.id() ? e.target : null);
      clearGhost(); if (hit && hit.length !== 0) { const f = from.data(), t = hit.data(); setPending({ a: { id: f.id, name: f.label, kind: f.kind }, b: { id: t.id, name: t.label, kind: t.kind } }); }
    });
    cy.on('mouseover', 'node', () => { if (host.current) host.current.style.cursor = connectRef.current ? 'crosshair' : 'pointer'; }); cy.on('mouseout', 'node', () => { if (host.current) host.current.style.cursor = ''; });
    const ro = new ResizeObserver(() => cy.resize()); ro.observe(host.current);
    return () => { ro.disconnect(); cy.destroy(); cyRef.current = null; };
  }, [needsGraph]); // eslint-disable-line react-hooks/exhaustive-deps

  const runLayout = useCallback((name = layout) => {
    const cy = cyRef.current; if (!cy || !cy.nodes().length) return;
    if (mode === 'pathway' && pathView && data) { const pos = pathwayPositions(pathView, data); cy.batch(() => cy.nodes().forEach((n) => { const p = pos.get(n.id()); if (p) n.position(p); })); cy.layout({ name: 'preset', fit: true, padding: 50, animate: false }).run(); setTimeout(() => { cy.resize(); cy.fit(undefined, 50); }, 150); } // the banner above the canvas changes its height after the first fit
    else { const big = cy.nodes().length > 320; cy.layout(LAYOUTS[big && name === 'cose' ? 'concentric' : name]).run(); }
    cy.nodes().forEach((n) => { posCache.current.set(n.id(), { ...n.position() }); });
  }, [layout, mode, pathView, data]);

  // keep the canvas in step with the data: add / update / remove elements (positions of what is already drawn are kept)
  useEffect(() => {
    const cy = cyRef.current; if (!cy || !data) return;
    if (mode === 'pathway' && pathwayId && !pathView) return; // wait for the pathway order so the first layout is final
    const stepIds = new Set(pathView?.steps.map((s) => s.reactionId) ?? []);
    const key = mode === 'pathway' ? `p:${pathwayId}` : 'n';
    if (lastKey.current !== key) { if (lastKey.current !== undefined) { cy.elements().remove(); posCache.current.clear(); } lastKey.current = key; } // network ↔ pathway: rebuild (containers and positions differ)
    const edges = mode === 'pathway' ? data.edges.filter((e) => e.origin !== 'step') : data.edges;
    const want = new Set(data.nodes.map((n) => n.id)); const wantE = new Set(edges.map((e) => e.id));
    let added = 0, fromCache = 0; const total = data.nodes.length; // new nodes start at distinct random spots: Cytoscape 3.30 throws when a rounded shape has an edge to a coincident node
    cy.batch(() => {
      cy.nodes().not('.ghost').forEach((n) => { if (!want.has(n.id())) cy.remove(n); }); cy.edges().not('.ghostEdge').forEach((e) => { if (!wantE.has(e.id())) cy.remove(e); });
      const parentOf = (n: XNode) => (mode === 'pathway' && pathwayId && n.type === 'reaction' && stepIds.has(n.id) ? pathwayId : undefined);
      for (const n of data.nodes) { const d = { id: n.id, label: n.label, type: n.type, kind: n.kind, degree: n.degree, more: n.more, parent: parentOf(n) }; const el = cy.getElementById(n.id); if (el.nonempty()) { el.data({ ...d, parent: undefined }); } else { const p = posCache.current.get(n.id); cy.add({ group: 'nodes', data: d, position: p ? { ...p } : { x: 40 + Math.random() * 800, y: 40 + Math.random() * 500 } }); added++; if (p) fromCache++; } }
      for (const e of edges) { if (!want.has(e.source) || !want.has(e.target)) continue; const el = cy.getElementById(e.id); if (el.nonempty()) el.data(edgeData(e)); else cy.add({ group: 'edges', data: edgeData(e) }); }
    });
    cy.nodes().not('.ghost').forEach((n) => { n.toggleClass('hidden', hidden.has(n.data('type'))); });
    cy.style().selector('node.hidden, edge.hidden').style('display', 'none').update();
    if (added > 0 && fromCache === added && mode !== 'pathway') { if (added === total) cy.fit(undefined, 40); } // every new node came back with its saved position (re-opened view, switching modes): keep the layout
    else if (added > 0) {
      if (mode !== 'pathway' && added < total && total - added > 0 && cy.nodes().filter((n) => posCache.current.has(n.id())).length >= total * 0.8) {
        // an expansion: keep everything that was placed, run the layout only around the new nodes
        cy.layout({ name: 'cose', animate: false, fit: false, randomize: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 95, numIter: 300, boundingBox: undefined as any }).run();
        cy.nodes().forEach((n) => { posCache.current.set(n.id(), { ...n.position() }); });
      } else runLayout();
    }
  }, [data, pathView, mode, pathwayId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const cy = cyRef.current; if (!cy) return; cy.nodes().not('.ghost').forEach((n) => { n.toggleClass('hidden', hidden.has(n.data('type'))); }); cy.style().selector('node.hidden, edge.hidden').style('display', 'none').update(); }, [hidden]);
  useEffect(() => { const cy = cyRef.current; if (!cy) return; const t = search.trim().toLowerCase(); cy.batch(() => { cy.elements().removeClass('hit faded'); if (t.length >= 2) { const m = cy.nodes().not('.ghost').filter((n) => String(n.data('label')).toLowerCase().includes(t)); m.addClass('hit'); if (m.length) cy.elements().not(m).not(m.connectedEdges()).addClass('faded'); } }); }, [search, data]);

  // ---------------------------------------------------------------- actions
  const expandNode = async (id: string) => {
    if (!wsId) return; try {
      const p = new URLSearchParams(query); p.set('focus', id); p.set('depth', '1'); p.delete('table'); p.delete('pathway'); p.delete('order');
      const g: XGraph = await get(`/api/explorer/graph?${p}`); setExtra((x) => [...x, g]); if (g.truncated) toast('Only the first connections were added. Filter, or expand a single node again.', 'info');
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  const exploreNetwork = (ids: string[]) => { setFocus(ids); setMode('network'); setPathwayId(null); setDepth(2); setExtra([]); posCache.current.clear(); };
  const showPathway = (id: string) => { setPathwayId(id); setMode('pathway'); setFocus([]); setExtra([]); posCache.current.clear(); };
  const reload = () => { cache.clear(); setTick((t) => t + 1); };
  const fit = () => cyRef.current?.fit(undefined, 40);
  const resetAll = () => { setFilters(NO_FILTERS); setHidden(new Set()); setSearch(''); setFocus(focusProp ?? []); setExtra([]); setDepth(focusProp?.length ? 2 : 1); setLimit(400); posCache.current.clear(); cyRef.current?.elements().unselect(); setSel({ nodes: [], edge: null }); setTimeout(() => cyRef.current && runLayout(), 50); };
  const focusNode = (id: string) => { const cy = cyRef.current; const n = cy?.getElementById(id); if (n && n.nonempty()) { cy!.elements().unselect(); n.select(); cy!.animate({ center: { eles: n }, zoom: Math.max(cy!.zoom(), 1) }, { duration: 250 }); return true; } return false; };
  const pickFound = (r: Pick) => { setSearch(''); if (!focusNode(r.id)) { setFocus((f) => (f.includes(r.id) ? f : [...f, r.id])); setMode('network'); setPathwayId(null); setExtra([]); } };
  const makeEdge = (e: any) => ({ id: e.id, origin: 'relationship', source: e.sourceId, target: e.targetId, directional: e.directional, typeName: e.type.name, label: e.type.name, evidence: e.evidenceClass, predicted: ['computationally_predicted', 'unverified'].includes(e.evidenceClass) });
  const doConnect = async () => {
    if (!pending) return; const { a, b } = pending;
    if (quick) { try { await post('/api/relationships', { sourceId: a.id, targetId: b.id, typeName: 'Associated with', evidenceClass: 'unverified', description: 'Created with quick connect – refine the type and evidence in the inspector.' }); toast(`Associated “${a.name}” with “${b.name}” (unverified). Select the line to refine it.`, 'ok'); reload(); } catch (e) { toast((e as Error).message, 'err'); } setPending(null); }
  };
  useEffect(() => { if (pending && quick && (data?.nodes.length ?? 0) <= 60) void doConnect(); }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportGraph = async (fmt: 'cytoscape' | 'graphml' | 'csv' | 'json') => {
    try {
      const p = new URLSearchParams(query); p.set('format', fmt); if (mode !== 'pathway') p.delete('pathway');
      const res = await fetch(`/api/explorer/export?${p}`, { headers: { 'x-vs': '1' } }); if (!res.ok) throw new Error((await res.json()).error);
      const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `network.${fmt}`; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  const exportPng = () => { const cy = cyRef.current; if (!cy) return; const a = document.createElement('a'); a.href = cy.png({ full: true, scale: 2, bg: '#ffffff' }); a.download = 'vierstation-network.png'; a.click(); };
  const saveView = () => {
    const cy = cyRef.current; const positions: Record<string, { x: number; y: number }> = {}; cy?.nodes().not('.ghost').forEach((n) => { positions[n.id()] = { ...n.position() }; });
    const blob = new Blob([JSON.stringify({ app: 'VierStation', kind: 'explorer-view', version: 1, savedAt: new Date().toISOString(), state: { mode, focus, depth, filters, pathwayId, limit, layout, hidden: [...hidden], expanded: extra.flatMap((g) => g.focus) }, positions })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'vierstation-view.vsview.json'; a.click(); URL.revokeObjectURL(a.href);
  };
  const openView = async (file: File) => {
    try {
      const v = parseViewFile(await file.text()); const s = v.state as any;
      cyRef.current?.elements().remove(); posCache.current = new Map(Object.entries(v.positions)); setFilters({ ...NO_FILTERS, ...(s.filters ?? {}) }); setFocus(s.focus ?? []); setDepth(s.depth ?? 1); setPathwayId(s.pathwayId ?? null); setLimit(s.limit ?? 400); setLayout(s.layout ?? 'cose'); setHidden(new Set(s.hidden ?? [])); setMode(s.mode ?? 'network'); setExtra([]); setTick((t) => t + 1);
      if (s.expanded?.length) setTimeout(() => { for (const id of s.expanded) void expandNode(id); }, 600);
      toast('View restored – the records shown are read from this computer, so they reflect any edits made since', 'ok');
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  const onKey = (e: React.KeyboardEvent) => {
    const cy = cyRef.current; if (!cy) return; const list = cy.nodes().not('.ghost').filter((n) => n.visible()).sort((a, b) => String(a.data('label')).localeCompare(String(b.data('label')))); if (!list.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const cur = cy.nodes(':selected').first(); const arr = list.toArray(); const i = cur.length ? arr.findIndex((x) => x.id() === cur.id()) : -1; const n = arr[(i + (e.key === 'ArrowRight' ? 1 : -1) + arr.length) % arr.length]; cy.elements().unselect(); n.select(); cy.animate({ center: { eles: n } }, { duration: 120 }); }
    else if (e.key === 'Enter') { const cur = cy.nodes(':selected').first(); if (cur.length) void expandNode(cur.id()); } else if (e.key === 'Escape') cy.elements().unselect();
  };

  // ---------------------------------------------------------------- filters UI
  const toggle = (k: 'kinds' | 'types' | 'evidence' | 'tags', v: string) => setFilters((f) => ({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] }));
  const activeFilters = filters.kinds.length + filters.types.length + filters.evidence.length + filters.tags.length + (filters.organism ? 1 : 0) + (filters.source ? 1 : 0) + (filters.verification ? 1 : 0);
  const presentTypes = useMemo(() => NODE_TYPES.filter((t) => data?.nodes.some((n) => n.type === t.id)), [data]);
  const presentEv = useMemo(() => EVIDENCE.filter((e) => data?.edges.some((x) => x.evidence === e.id && (x.origin === 'relationship' || x.origin === 'field'))), [data]);
  const single = sel.nodes.length === 1 ? sel.nodes[0] : null;
  const openRec = (id: string) => (onOpenRecord ? onOpenRecord(id) : navigate(`/record/${id}`));

  const filterPanel = (
    <aside className="xfilters" aria-label="Filters">
      <div className="row between"><b>Filters</b>{activeFilters > 0 && <button className="btn ghost sm" onClick={() => setFilters(NO_FILTERS)}>Clear ({activeFilters})</button>}</div>
      <details open><summary>Entity type <HelpTip k="xpFilterKinds" label="entity type" /></summary>
        {GRAPH_KINDS.map((k) => <label key={k} className="check small"><input type="checkbox" checked={filters.kinds.includes(k)} onChange={() => toggle('kinds', k)} /><ShapeGlyph type={k} size={14} /><span>{KIND_LABEL[k]} <span className="muted">{facets?.kinds.find((x: any) => x.kind === k)?.n ?? ''}</span></span></label>)}
      </details>
      <details open><summary>Relationship type <HelpTip k="xpFilterTypes" label="relationship type" /></summary>
        <div className="scrollbox">{(facets?.types ?? []).map((t: any) => <label key={t.id} className="check small"><input type="checkbox" checked={filters.types.includes(t.id)} onChange={() => toggle('types', t.id)} /><span>{t.name} <span className="muted">{t.n || ''}</span></span></label>)}</div>
      </details>
      <details open><summary>Evidence <HelpTip k="xpFilterEvidence" label="evidence" /></summary>
        {EVIDENCE.map((e) => <label key={e.id} className="check small"><input type="checkbox" checked={filters.evidence.includes(e.id)} onChange={() => toggle('evidence', e.id)} /><LineGlyph ev={e.id} /><span>{e.label} <span className="muted">{facets?.evidence.find((x: any) => x.id === e.id)?.n ?? ''}</span></span></label>)}
      </details>
      <details><summary>Tags <HelpTip k="xpFilterTags" label="tags" /></summary>
        <div className="scrollbox">{(facets?.tags ?? []).length === 0 ? <span className="muted small">No tags yet.</span> : facets.tags.map((t: any) => <label key={t.tag} className="check small"><input type="checkbox" checked={filters.tags.includes(t.tag)} onChange={() => toggle('tags', t.tag)} /><span>{t.tag} <span className="muted">{t.n}</span></span></label>)}</div>
      </details>
      <details><summary>Organism · source · status</summary>
        <label className="fld"><span className="small">Organism <HelpTip k="xpFilterOrganism" label="organism" /></span><input className="input" list="orgList" value={filters.organism} onChange={(e) => setFilters({ ...filters, organism: e.target.value })} aria-label="Organism filter" /><datalist id="orgList">{(facets?.organisms ?? []).map((o: string) => <option key={o} value={o} />)}</datalist></label>
        <label className="fld"><span className="small">Source database <HelpTip k="xpFilterSource" label="source database" /></span><select className="select" value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value })} aria-label="Source database filter"><option value="">Any</option>{(facets?.sources ?? []).map((s: string) => <option key={s}>{s}</option>)}</select></label>
        <label className="fld"><span className="small">Verification <HelpTip k="xpFilterVerification" label="verification" /></span><select className="select" value={filters.verification} onChange={(e) => setFilters({ ...filters, verification: e.target.value })} aria-label="Verification filter"><option value="">Any</option>{VERIFICATION.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label>
      </details>
      <details open><summary>Pathway <HelpTip k="xpFilterPathway" label="pathway" /></summary>
        <select className="select" value={pathwayId ?? ''} onChange={(e) => { const v = e.target.value; if (v && mode === 'flow') { setPathwayId(v); setExtra([]); } else if (v) showPathway(v); else { setPathwayId(null); if (mode === 'pathway' || mode === 'flow') setMode('network'); } }} aria-label="Pathway"><option value="">None</option>{(facets?.pathways ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name} ({p.steps})</option>)}</select>
      </details>
    </aside>
  );

  const modeBtn = (m: Mode, label: string, k: string) => <Hint k={k}><button role="tab" aria-selected={mode === m} className={`btn sm ${mode === m ? '' : 'secondary'}`} onClick={() => { setMode(m); if (m === 'network') setPathwayId((p) => (mode === 'pathway' ? null : p)); }}>{label}</button></Hint>;

  return (
    <div className={`xp${embedded ? ' embedded' : ''}`}>
      <div className="xp-bar">
        {!embedded && <h1 className="xp-title">Explorer</h1>}
        <div role="tablist" aria-label="View" className="seg">{modeBtn('network', 'Network', 'xpModeNetwork')}{modeBtn('pathway', 'Pathway', 'xpModePathway')}{modeBtn('flow', 'Flow', 'xpModeFlow')}{modeBtn('table', 'Table', 'xpModeTable')}</div>
        <div className="xp-search"><Icon name="search" size={14} /><input className="input" placeholder="Find a record…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search the network by name" />
          {search.trim() && found.length > 0 && <div className="picklist" role="listbox">{found.slice(0, 8).map((r) => <button key={r.id} role="option" aria-selected="false" className="pickrow" onClick={() => pickFound(r)}><ShapeGlyph type={r.kind} size={15} /><span>{r.name}</span><span className="muted small">{KIND_LABEL[r.kind]}{r.accession ? ` · ${r.accession}` : ''}</span></button>)}</div>}
        </div>
        <span className="grow" />
        {needsGraph && <>
          {focus.length > 0 && mode === 'network' && <Hint k="xpDepth"><label className="row small" style={{ gap: 4 }}>Depth<select className="select" style={{ width: 56, minHeight: 28 }} value={depth} onChange={(e) => setDepth(Number(e.target.value))} aria-label="Depth of the related network">{[1, 2, 3, 4].map((d) => <option key={d}>{d}</option>)}</select></label></Hint>}
          {mode === 'network' && <Hint k="xpLayout"><select className="select" style={{ width: 'auto', minHeight: 30 }} value={layout} onChange={(e) => { setLayout(e.target.value); runLayout(e.target.value); }} aria-label="Layout">{Object.entries(LAYOUT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Hint>}
          <Hint k="xpFit"><button className="btn secondary sm" onClick={fit}><Icon name="search" /> Fit</button></Hint>
          <Hint k="xpConnect"><button className={`btn sm ${connect ? '' : 'secondary'}`} aria-pressed={connect} onClick={() => setConnect(!connect)}><Icon name="link" /> {connect ? 'Connecting…' : 'Connect'}</button></Hint>
        </>}
        <Hint k="xpAddRelation"><button className="btn sm" onClick={() => setDlg('relation')}><Icon name="plus" /> Add relation</button></Hint>
        <MenuButton icon="download" label="Export" className="btn secondary sm" title="Export and views">
          {(close) => (<>
            <button className="item" onClick={() => { close(); void exportGraph('cytoscape'); }}>Cytoscape JSON (.cyjs)</button><button className="item" onClick={() => { close(); void exportGraph('graphml'); }}>GraphML</button><button className="item" onClick={() => { close(); void exportGraph('csv'); }}>Relationships CSV (with evidence)</button><button className="item" onClick={() => { close(); void exportGraph('json'); }}>VierStation JSON</button>
            {needsGraph && <><hr /><button className="item" onClick={() => { close(); exportPng(); }}>Image (PNG)</button><button className="item" onClick={() => { close(); saveView(); }}>Save this view (re-openable)</button></>}
            <label className="item" style={{ cursor: 'pointer' }}>Open a saved view…<input type="file" accept=".json,.vsview.json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; close(); if (f) void openView(f); e.target.value = ''; }} /></label>
          </>)}
        </MenuButton>
        <MenuButton icon="cog" label="Create" className="btn secondary sm" title="Reactions, pathways and relationship types">
          {(close) => (<><button className="item" onClick={() => { close(); setDlg('reaction'); }}><Icon name="reaction" /> New reaction</button><button className="item" onClick={() => { close(); setDlg('pathway'); }}><Icon name="pathway" /> New pathway</button><hr /><button className="item" onClick={() => { close(); setDlg('types'); }}>Relationship types…</button></>)}
        </MenuButton>
        <button className="btn ghost sm" onClick={resetAll} title="Reset the view: clear filters, search and expansions"><Icon name="clock" /> Reset</button>
        <Hint k="xpFilters"><button className={`btn ghost sm${filtersOpen ? ' active' : ''}`} aria-pressed={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><Icon name="filter" /> Filters{activeFilters ? ` (${activeFilters})` : ''}</button></Hint>
      </div>
      {net.offline && <div className="xp-note small" role="status">Working offline: everything shown here is stored on this computer. Fetching new data from scientific databases waits until you are online.</div>}
      {connect && needsGraph && <div className="xp-note small" role="status">Connect mode: drag from one node onto another to propose a relationship. Nothing is saved until you confirm the type and evidence in the panel. {(data?.nodes.length ?? 0) <= 60 && <label className="check small" style={{ marginLeft: 8 }}><input type="checkbox" checked={quick} onChange={(e) => setQuick(e.target.checked)} /><span>Quick connect (skip the panel – saves “Associated with”, unverified) <HelpTip k="xpQuick" label="quick connect" /></span></label>}</div>}
      <div className="xp-body">
        {filtersOpen && filterPanel}
        <div className="xp-main">
          {mode === 'pathway' && pathView && <PathwayBanner v={pathView} />}
          {mode === 'pathway' && !pathwayId && <Empty title="Choose a pathway">Pick one in the filter panel (or create it from “Create → New pathway”). The pathway view groups its reactions in an outlined container and lays them out only along the order you or a curated source defined.</Empty>}
          {err && <Empty title="Could not load the network">{err} <button className="btn secondary sm" onClick={reload}>Try again</button></Empty>}
          {needsGraph && !err && !(mode === 'pathway' && !pathwayId) && (
            <div className="xp-canvaswrap">
              <div ref={host} className="xp-canvas" tabIndex={0} onKeyDown={onKey} role="application" aria-label="Relationship network. Arrow keys move between records, Enter shows more connections. Table mode lists the same relationships as text." />
              {loading && <div className="xp-loading"><Spinner label="Loading…" /></div>}
              {data && !data.nodes.length && !loading && <div className="xp-empty"><Empty title="Nothing to draw yet">{filters.kinds.length + filters.types.length + filters.evidence.length + filters.tags.length ? 'No relationships match these filters.' : 'Add a relation (“Add relation”), create a reaction or pathway, or run discovery on a record to see how records connect.'}</Empty></div>}
              {data && data.nodes.length > 0 && (
                <div className="xp-legend" aria-label="Legend">
                  <div className="row between"><b className="small">Legend</b><HelpTip k="xpLegend" label="legend" /></div>
                  {presentTypes.map((t) => <label key={t.id} className="check small" title={t.help}><input type="checkbox" checked={!hidden.has(t.id)} onChange={() => setHidden((h) => { const n = new Set(h); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n; })} aria-label={`Show ${t.label} nodes`} /><ShapeGlyph type={t.id} size={16} /><span>{t.label}</span></label>)}
                  <div className="legsep" />
                  {presentEv.map((e) => <div key={e.id} className="small leg"><LineGlyph ev={e.id} />{e.label}</div>)}
                  <div className="small leg"><svg width="34" height="10" aria-hidden="true"><line x1="1" y1="5" x2="33" y2="5" stroke="#2B4F8C" strokeWidth="2" /></svg>Reaction role / pathway link</div>
                  <div className="small leg"><span className="dbl" aria-hidden="true" />More connections not shown</div>
                  {data.truncated && <div className="small muted">Showing {data.nodes.length} records (limit {limit}). <button className="btn ghost sm" style={{ padding: '0 4px' }} onClick={() => setLimit(Math.min(3000, limit * 2))}>Show more</button></div>}
                </div>
              )}
              {data && data.warnings.length > 0 && <div className="xp-warn small">{data.warnings[0]}</div>}
            </div>
          )}
          {mode === 'flow' && <FlowView pathwayId={pathwayId} onSelect={(id) => setSel({ nodes: [id], edge: null })} tick={tick} />}
          {mode === 'table' && <RelTable filters={filters} tick={tick} onSelect={(r) => setSel({ nodes: [], edge: makeEdge(r) })} />}
        </div>
        {single && <NodeInspector key={single} id={single} more={nodeById.get(single)?.more ?? 0} onClose={() => { cyRef.current?.elements().unselect(); setSel({ nodes: [], edge: null }); }} onExpand={() => void expandNode(single)} onExplore={() => exploreNetwork([single])} onSelectEdge={(eid) => { const c = cyRef.current?.getElementById(eid); if (c?.nonempty()) { cyRef.current!.elements().unselect(); c.select(); } else get(`/api/relationships/${eid}`).then((r) => setSel({ nodes: [], edge: makeEdge(r.relationship) })); }} onOpenOther={openRec} onChanged={reload} onShowPathway={showPathway} />}
        {!single && sel.nodes.length > 1 && (
          <aside className="insp"><header><div className="grow"><h2>{sel.nodes.length} records selected</h2></div><button className="btn ghost icon sm" onClick={() => { cyRef.current?.elements().unselect(); setSel({ nodes: [], edge: null }); }} aria-label="Clear selection"><Icon name="x" /></button></header>
            <div className="body"><div className="col" style={{ gap: 4 }}>{sel.nodes.map((id) => <button key={id} className="relmain" onClick={() => { cyRef.current?.elements().unselect(); focusNode(id); }}><ShapeGlyph type={nodeById.get(id)?.type ?? 'chemical'} size={15} /><span>{names[id]}</span></button>)}</div>
              <div className="row wrap" style={{ gap: 6, marginTop: 10 }}><button className="btn secondary sm" onClick={() => exploreNetwork(sel.nodes)}><Icon name="graph" /> Explore their network</button><button className="btn secondary sm" onClick={() => { const cy = cyRef.current; if (!cy) return; const keep = cy.nodes(':selected'); cy.elements().not(keep.union(keep.connectedEdges())).addClass('faded'); }}>Highlight only these</button></div></div></aside>
        )}
        {!single && sel.edge && <EdgeInspector key={sel.edge.id} edge={sel.edge} names={names} onClose={() => { cyRef.current?.elements().unselect(); setSel({ nodes: [], edge: null }); }} onChanged={reload} onSelectNode={(id) => { if (!focusNode(id)) setSel({ nodes: [id], edge: null }); }} />}
      </div>

      {pending && !quick && <Modal title="Create a relationship?" onClose={() => setPending(null)} size="wide"><div className="muted small" style={{ marginBottom: 8 }}>You connected two nodes. A relationship is only recorded when you choose its type and evidence and press Save.</div><RelationEditor source={pending.a} fixedTarget={pending.b} onSaved={() => { reload(); setPending(null); }} onCancel={() => setPending(null)} saveLabel="Save relationship" /></Modal>}
      {dlg === 'relation' && <AddRelationDialog onClose={() => setDlg(null)} onSaved={reload} />}
      {dlg === 'reaction' && <ReactionEditor onClose={() => setDlg(null)} onSaved={() => reload()} />}
      {dlg === 'pathway' && <PathwayEditor onClose={() => setDlg(null)} onSaved={(id) => { reload(); showPathway(id); }} />}
      {dlg === 'types' && <TypesManager onClose={() => { setDlg(null); reload(); }} />}
      <span className="sr-only" aria-live="polite">{loading ? 'Loading network' : data ? `${data.nodes.length} records and ${data.edges.length} connections shown` : ''}</span>
      {void projectId}
    </div>
  );
}

function AddRelationDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [src, setSrc] = useState<Pick | null>(null);
  return (
    <Modal title="Add a relationship" onClose={onClose} size="wide">
      <div className="col" style={{ gap: 12 }}>
        <div><span className="small">First record</span><TargetPicker value={src} onChange={setSrc} label="First record" /></div>
        {src && <RelationEditor key={src.id} source={src} onSaved={onSaved} onCancel={onClose} />}
      </div>
    </Modal>
  );
}
void Chip;
