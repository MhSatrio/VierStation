import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Field, ViewConfig, ViewMeta, ViewType } from '../../shared/types.ts';
import { parseDelimited } from '../../shared/csv.ts';
import { del, patch, post } from '../lib/api.ts';
import { navigate, setQuery, useQueryParam } from '../lib/router.tsx';
import { invalidateTable, toast, useSession, useTableDetail } from '../lib/store.ts';
import { Grid, visibleFields } from './Grid.tsx';
import type { GridApi } from './Grid.tsx';
import { Calendar, Gallery, Kanban, ListView } from './Views.tsx';
import { FilterButton, GroupButton, SortButton, Searchbar, ViewSummary } from './Toolbar.tsx';
import { FieldEditorModal, FieldsManager } from './FieldEditor.tsx';
import { RecordPanel } from './RecordPanel.tsx';
import { Empty, MenuButton, Modal, Spinner, confirmDialog } from './common.tsx';
import { KIND_ICON, Icon } from './icons.tsx';
import type { QSpec } from '../lib/data.ts';
import { refreshTables } from '../lib/store.ts';

const GraphView = lazy(() => import('./GraphView.tsx').then((m) => ({ default: m.GraphView })));
const VIEW_ICON: Record<ViewType, string> = { grid: 'grid', kanban: 'kanban', gallery: 'gallery', list: 'list', calendar: 'calendar', graph: 'graph' };
const VIEW_LABEL: Record<ViewType, string> = { grid: 'Grid', kanban: 'Kanban', gallery: 'Gallery', list: 'List', calendar: 'Calendar', graph: 'Relationship graph' };

export function TablePage({ tableId }: { tableId: string }) {
  const { detail, error, reload } = useTableDetail(tableId);
  const recordId = useQueryParam('r');
  const viewParam = useQueryParam('v');
  const [localCfg, setLocalCfg] = useState<Record<string, ViewConfig>>({});
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fieldEd, setFieldEd] = useState<{ field?: Field } | null>(null);
  const [fieldsMgr, setFieldsMgr] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [newView, setNewView] = useState(false);
  const [graphDepth, setGraphDepth] = useState(2);
  const [gridTotal, setGridTotal] = useState<number | null>(null);
  const [dups, setDups] = useState(false);
  const gridApi = useRef<GridApi | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setSearch(''); setSelected(new Set()); setLocalCfg({}); setFieldEd(null); }, [tableId]);

  const views = detail?.views ?? [];
  const view: ViewMeta | undefined = views.find((v) => v.id === viewParam) ?? views[0];
  const config: ViewConfig = (view && localCfg[view.id]) ?? view?.config ?? {};
  const canEdit = detail?.table.level === 'editor' || detail?.table.level === 'admin';
  const isAdmin = detail?.table.level === 'admin';

  const setConfig = useCallback((c: ViewConfig) => {
    if (!view) return;
    setLocalCfg((l) => ({ ...l, [view.id]: c }));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { patch(`/api/views/${view.id}`, { config: c }).then(() => invalidateTable(tableId), (e) => toast(e.message, 'err')); }, 350);
  }, [view, tableId]);

  const spec: QSpec = useMemo(() => ({ filter: config.filter, sorts: config.sorts, groupBy: config.groupBy ?? undefined, search: search.trim() || undefined }), [config.filter, config.sorts, config.groupBy, search]);
  const openRecord = (id: string | null) => setQuery('r', id, false);

  if (error) return <div className="page"><Empty title="Cannot open this table">{error}</Empty></div>;
  if (!detail || !view) return <div className="page"><Spinner label="Loading table…" /></div>;
  const t = detail.table;
  const fieldsAll = detail.fields;

  const bulkSet = async (f: Field, value: unknown) => {
    try { const r = await post(`/api/tables/${tableId}/bulk`, { op: 'update', ids: [...selected], fields: { [f.id]: value }, createChoices: true }); toast(`Updated ${r.affected} record(s)`, 'ok'); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const exportFile = async (format: 'csv' | 'json', onlySelected: boolean) => {
    try {
      const res = await fetch(`/api/tables/${tableId}/export`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-vs': '1' }, body: JSON.stringify({ format, ...(onlySelected ? { ids: [...selected] } : spec) }) });
      if (!res.ok) throw new Error((await res.json()).error);
      const blob = await res.blob(); const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `export.${format}`; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  const body = (() => {
    const common = { tableId, detail, config, spec, canEdit, onOpen: (id: string) => openRecord(id) };
    switch (view.type) {
      case 'grid': return <Grid {...common} setConfig={setConfig} selected={selected} setSelected={setSelected} apiRef={gridApi} onTotal={setGridTotal} onEditField={(f) => setFieldEd({ field: f })} />;
      case 'kanban': return <Kanban {...common} setConfig={setConfig} />;
      case 'gallery': return <Gallery {...common} />;
      case 'list': return <ListView {...common} />;
      case 'calendar': return <Calendar {...common} setConfig={setConfig} />;
      case 'graph': return <Suspense fallback={<div className="empty"><Spinner /></div>}><GraphView source={{ kind: 'table', id: tableId }} depth={config.graphDepth ?? graphDepth} onDepth={(d) => { setGraphDepth(d); setConfig({ ...config, graphDepth: d }); }} onOpen={(id) => openRecord(id)} highlight={recordId ?? undefined} /></Suspense>;
    }
  })();

  return (
    <div className="page fill">
      <div className="tbl-head">
        <div className="top">
          <span style={{ color: 'var(--brand)', display: 'flex' }}><Icon name={KIND_ICON[t.kind] ?? 'grid'} size={22} /></span>
          <h1>{t.name}</h1>
          {t.description && <span className="muted small hide-m">{t.description}</span>}
          <span className="grow" />
          {canEdit && <button className="btn sm" onClick={() => { if (view.type === 'grid') void gridApi.current?.createRecord(); else void post(`/api/tables/${tableId}/records`, { fields: {} }).then((r) => openRecord(r.records[0].id)).catch((e) => toast(e.message, 'err')); }}><Icon name="plus" /> Add record</button>}
          {(t.kind === 'dna' || t.kind === 'rna') && <button className="btn secondary sm" onClick={() => navigate('/map')} title="Show where these samples were collected on a globe"><Icon name="globe" /> Show map</button>}
          {canEdit && <button className="btn secondary sm hide-m" onClick={() => setImportOpen(true)}><Icon name="upload" /> Import CSV</button>}
          <MenuButton icon="download" className="btn secondary sm hide-m" label="Export">{(close) => (<><button className="item" onClick={() => { close(); void exportFile('csv', false); }}>CSV (current filters)</button><button className="item" onClick={() => { close(); void exportFile('json', false); }}>JSON with links & evidence</button></>)}</MenuButton>
        </div>
        <div className="viewtabs" role="tablist" aria-label="Views">
          {views.map((v) => (
            <button key={v.id} role="tab" aria-selected={v.id === view.id} className={v.id === view.id ? 'on' : ''} onClick={() => { setQuery('v', v.id, false); setSelected(new Set()); }}
              onDoubleClick={async () => { if (!canEdit) return; const n = prompt('Rename view', v.name); if (n?.trim()) { await patch(`/api/views/${v.id}`, { name: n.trim() }); invalidateTable(tableId); reload(); } }}>
              <Icon name={VIEW_ICON[v.type]} size={14} />{v.name}
            </button>
          ))}
          {canEdit && <button onClick={() => setNewView(true)} aria-label="Add view" title="Add view"><Icon name="plus" size={14} /> View</button>}
          {canEdit && views.length > 1 && <button onClick={async () => { if (await confirmDialog(`Delete the view “${view.name}”? Records are not affected.`, 'Delete view')) { await del(`/api/views/${view.id}`); invalidateTable(tableId); setQuery('v', null); reload(); } }} aria-label="Delete this view" title="Delete this view" style={{ marginLeft: 'auto' }}><Icon name="trash" size={14} /></button>}
        </div>
        <div className="toolbar">
          {['grid', 'kanban', 'gallery', 'list', 'calendar'].includes(view.type) && <>
            <FilterButton fields={fieldsAll} config={config} setConfig={setConfig} />
            {(view.type === 'grid' || view.type === 'gallery' || view.type === 'list') && <SortButton fields={fieldsAll} config={config} setConfig={setConfig} />}
            {view.type === 'grid' && <GroupButton fields={fieldsAll} config={config} setConfig={setConfig} />}
            {t.kind === 'chemical' && <button className="btn secondary sm" onClick={() => setDups(true)}><Icon name="copy" /> Duplicates</button>}
            <button className="btn secondary sm" onClick={() => setFieldsMgr(true)}><Icon name="eye" /> Fields{(config.hidden?.length ?? 0) > 0 ? ` (${config.hidden!.length} hidden)` : ''}</button>
            <Searchbar value={search} onChange={setSearch} />
          </>}
          {view.type === 'graph' && <span className="muted small">Nodes are records; lines are links coloured by evidence class. Drag nodes, scroll to zoom, click to open.</span>}
          <span className="sp" />
          <ViewSummary total={view.type === 'grid' ? gridTotal : t.recordCount ?? null} />
        </div>
        {selected.size > 0 && view.type === 'grid' && (
          <div className="bulkbar" role="toolbar" aria-label="Bulk actions">
            <b>{selected.size.toLocaleString()} selected</b>
            {canEdit && <MenuButton className="btn sm" label="Set field…">{(close) => <BulkSet fields={fieldsAll} onApply={(f, v) => { close(); void bulkSet(f, v); }} />}</MenuButton>}
            {canEdit && <button className="btn sm" onClick={async () => { const r = await post(`/api/tables/${tableId}/bulk`, { op: 'duplicate', ids: [...selected] }); toast(`Duplicated ${r.affected}`, 'ok'); setSelected(new Set()); }}>Duplicate</button>}
            <button className="btn sm" onClick={() => void exportFile('csv', true)}>Export CSV</button>
            <a className="btn sm" href={`/analysis?table=${tableId}&ids=${[...selected].slice(0, 200).join(',')}`} onClick={(e) => { e.preventDefault(); sessionStorage.setItem('vs.analysisIds', JSON.stringify([...selected])); navigate(`/analysis?table=${tableId}&selection=1`); }}>Analyse…</a>
            {canEdit && <button className="btn sm" onClick={async () => { if (await confirmDialog(`Delete ${selected.size} record(s)? This cannot be undone.`, 'Delete')) { const r = await post(`/api/tables/${tableId}/bulk`, { op: 'delete', ids: [...selected] }); toast(`Deleted ${r.affected}`, 'ok'); setSelected(new Set()); } }}>Delete</button>}
            <span className="grow" /><button className="btn sm" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="viewbody">{body}</div>
        {recordId && <RecordPanel key={recordId} recordId={recordId} onClose={() => openRecord(null)} onOpenOther={(id) => navigate(`/record/${id}`)} />}
      </div>

      {fieldEd && <FieldEditorModal tableId={tableId} detail={detail} field={fieldEd.field} onClose={() => setFieldEd(null)} onSaved={() => { reload(); void refreshTables(); }} />}
      {fieldsMgr && <FieldsManager tableId={tableId} detail={detail} hidden={config.hidden ?? []} onToggle={(id) => setConfig({ ...config, hidden: (config.hidden ?? []).includes(id) ? config.hidden!.filter((x) => x !== id) : [...(config.hidden ?? []), id] })} onClose={() => setFieldsMgr(false)} onChanged={reload} onEdit={(f) => { setFieldsMgr(false); setFieldEd({ field: f }); }} onAdd={() => { setFieldsMgr(false); setFieldEd({}); }} />}
      {importOpen && <ImportModal tableId={tableId} detail={detail} onClose={() => setImportOpen(false)} onDone={() => { gridApi.current?.reload(); reload(); void refreshTables(); }} />}
      {newView && <NewView tableId={tableId} onClose={() => setNewView(false)} onCreated={(v) => { invalidateTable(tableId); reload(); setQuery('v', v.id, false); }} />}
      {dups && <Duplicates tableId={tableId} canEdit={canEdit} onClose={() => setDups(false)} />}
    </div>
  );
}

function BulkSet({ fields, onApply }: { fields: Field[]; onApply: (f: Field, v: unknown) => void }) {
  const editable = fields.filter((f) => !['formula', 'relation', 'lookup', 'rollup', 'createdTime', 'lastModifiedTime', 'attachment', 'structure', 'sequence'].includes(f.type));
  const [fid, setFid] = useState(editable[0]?.id ?? '');
  const f = editable.find((x) => x.id === fid);
  const [val, setVal] = useState<string>('');
  return (
    <div className="col" style={{ width: 280, padding: 6 }}>
      <select className="select" value={fid} onChange={(e) => { setFid(e.target.value); setVal(''); }} aria-label="Field">{editable.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      {f && (f.type === 'singleSelect' || f.type === 'status') ? <select className="select" value={val} onChange={(e) => setVal(e.target.value)} aria-label="Value"><option value="">(clear)</option>{f.options.choices?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        : f?.type === 'checkbox' ? <select className="select" value={val} onChange={(e) => setVal(e.target.value)} aria-label="Value"><option value="">Unchecked</option><option value="true">Checked</option></select>
        : <input className="input" type={f?.type === 'date' ? 'date' : f?.type === 'number' ? 'number' : 'text'} value={val} onChange={(e) => setVal(e.target.value)} placeholder="Value" aria-label="Value" />}
      <button className="btn sm" onClick={() => f && onApply(f, f.type === 'checkbox' ? val === 'true' : val === '' ? null : f.type === 'number' ? Number(val) : f.type === 'multiSelect' ? [val] : val)}>Apply to selected</button>
    </div>
  );
}

function NewView({ tableId, onClose, onCreated }: { tableId: string; onClose: () => void; onCreated: (v: ViewMeta) => void }) {
  const [type, setType] = useState<ViewType>('grid');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Add view" size="narrow" onClose={onClose} footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { const r = await post(`/api/tables/${tableId}/views`, { type, name: name.trim() || VIEW_LABEL[type] }); onCreated(r.view); onClose(); } catch (e) { toast((e as Error).message, 'err'); setBusy(false); } }}>Create view</button></>}>
      <div className="col">
        <div className="tiles" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {(Object.keys(VIEW_LABEL) as ViewType[]).map((vt) => <button key={vt} className={`tile${type === vt ? ' active' : ''}`} style={{ textAlign: 'center', ...(type === vt ? { borderColor: 'var(--brand)', background: 'var(--sky-soft)' } : {}) }} onClick={() => setType(vt)}><Icon name={VIEW_ICON[vt]} size={22} /><div className="l" style={{ color: 'var(--ink)' }}>{VIEW_LABEL[vt]}</div></button>)}
        </div>
        <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={VIEW_LABEL[type]} /></label>
        <span className="muted small">All views show the same records – editing in one updates the others.</span>
      </div>
    </Modal>
  );
}

/** CSV import: map columns → fields (or create new text fields), then create records in chunks. */
function ImportModal({ tableId, detail, onClose, onDone }: { tableId: string; detail: { fields: Field[] }; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [map, setMap] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const editable = detail.fields.filter((f) => !['formula', 'relation', 'lookup', 'rollup', 'createdTime', 'lastModifiedTime', 'attachment', 'structure', 'user'].includes(f.type));
  const onFile = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) { setErr('Files over 25 MB are not supported here.'); return; }
    const parsed = parseDelimited(await file.text());
    if (parsed.length < 2) { setErr('The file needs a header row and at least one data row.'); return; }
    setErr(''); setRows(parsed);
    setMap(parsed[0].map((h) => editable.find((f) => f.name.toLowerCase() === h.trim().toLowerCase())?.id ?? '__new'));
  };
  const run = async () => {
    if (!rows) return;
    setBusy('Preparing…'); setErr('');
    try {
      const cols = [...map];
      for (let i = 0; i < cols.length; i++) if (cols[i] === '__new') { const r = await post(`/api/tables/${tableId}/fields`, { name: rows[0][i].trim() || `Column ${i + 1}`, type: 'text' }); cols[i] = r.field.id; }
      const data = rows.slice(1);
      let done = 0;
      for (let s = 0; s < data.length; s += 500) {
        const chunk = data.slice(s, s + 500).map((r) => Object.fromEntries(cols.map((id, i) => [id, r[i]]).filter(([id, v]) => id && id !== '__skip' && v !== undefined && v !== '')));
        try { await post(`/api/tables/${tableId}/records`, { records: chunk, createChoices: true }); } catch (e) { throw new Error(`Rows ${s + 2}–${s + chunk.length + 1}: ${(e as Error).message}`); }
        done += chunk.length; setBusy(`Imported ${done.toLocaleString()} of ${data.length.toLocaleString()}…`);
      }
      toast(`Imported ${data.length.toLocaleString()} records`, 'ok'); onDone(); onClose();
    } catch (e) { setErr((e as Error).message + ' Records before the failing batch were imported.'); setBusy(''); }
  };
  return (
    <Modal title="Import CSV / TSV" size="wide" onClose={onClose} footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={!rows || !!busy} onClick={run}>{busy || `Import ${rows ? (rows.length - 1).toLocaleString() : ''} rows`}</button></>}>
      <div className="col">
        {err && <div className="notice err">{err}</div>}
        {!rows ? (
          <label className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void onFile(f); }}>
            <Icon name="upload" size={22} /><div>Drop a .csv / .tsv file here or <u>choose a file</u></div>
            <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" className="sr-only" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
          </label>
        ) : (
          <>
            <p className="muted small" style={{ margin: 0 }}>Match each column to a field. Select/status options are created automatically; invalid values (e.g. text in a number field) stop the import with the row range.</p>
            <table className="t"><thead><tr><th>CSV column</th><th>Example</th><th>Import into</th></tr></thead><tbody>
              {rows[0].map((h, i) => (
                <tr key={i}><td><b>{h}</b></td><td className="muted small">{rows[1][i]?.slice(0, 40)}</td>
                  <td><select className="select" value={map[i]} onChange={(e) => setMap(map.map((m, j) => (j === i ? e.target.value : m)))} aria-label={`Field for ${h}`}><option value="__skip">(skip this column)</option><option value="__new">+ New text field “{h}”</option>{editable.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></td></tr>
              ))}
            </tbody></table>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Possible duplicate chemicals (same CID / ChEMBL ID / InChIKey, or same structure skeleton). Merge keeps all links and evidence. */
function Duplicates({ tableId, canEdit, onClose }: { tableId: string; canEdit: boolean; onClose: () => void }) {
  const [groups, setGroups] = useState<{ reason: string; ids: string[]; names: string[] }[] | null>(null);
  const [keep, setKeep] = useState<Record<number, string>>({});
  const load = () => import('../lib/api.ts').then(({ get }) => get(`/api/tables/${tableId}/duplicates`)).then((r) => setGroups(r.groups), () => setGroups([]));
  useEffect(() => { void load(); }, [tableId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Possible duplicate chemicals" size="wide" onClose={onClose} footer={<button className="btn" onClick={onClose}>Done</button>}>
      {!groups ? <Spinner /> : groups.length === 0 ? <Empty title="No duplicates found">Compounds are matched by PubChem CID, ChEMBL ID, InChIKey and the structure skeleton (first block of the InChIKey).</Empty> : (
        <div className="col">
          <div className="notice small">Same InChIKey = same structure. A matching <i>skeleton</i> only means the connectivity is the same – the records may differ in stereochemistry, charge or isotopes, so check before merging.</div>
          {groups.map((g, i) => (
            <div key={i} className="panel"><header><b className="small">{g.reason}</b></header><div className="pb col" style={{ gap: 4 }}>
              {g.ids.map((id, k) => <label key={id} className="check"><input type="radio" name={`g${i}`} checked={(keep[i] ?? g.ids[0]) === id} onChange={() => setKeep({ ...keep, [i]: id })} /> {g.names[k]} <span className="muted small mono">{id}</span></label>)}
              {canEdit && <button className="btn secondary sm" style={{ alignSelf: 'flex-start' }} onClick={async () => { const k = keep[i] ?? g.ids[0]; if (!await confirmDialog(`Merge ${g.ids.length - 1} record(s) into “${g.names[g.ids.indexOf(k)]}”? Links, evidence and provenance are moved; the duplicates are deleted.`, 'Merge', false)) return; try { await post(`/api/tables/${tableId}/merge`, { keepId: k, dropIds: g.ids.filter((x) => x !== k) }); toast('Merged', 'ok'); void load(); } catch (e) { toast((e as Error).message, 'err'); } }}>Merge into selected</button>}
            </div></div>
          ))}
        </div>
      )}
    </Modal>
  );
}
