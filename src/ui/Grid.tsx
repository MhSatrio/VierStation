import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Field, RecordRow, ViewConfig } from '../../shared/types.ts';
import { cellText } from '../../shared/filters.ts';
import { patch, post } from '../lib/api.ts';
import { useRecordPages } from '../lib/data.ts';
import type { QSpec } from '../lib/data.ts';
import { toast } from '../lib/store.ts';
import type { TableDetail } from '../lib/store.ts';
import { COL_WIDTH, CellView, InlineInput, NOT_EDITABLE, RelationEditor, SelectEditor, SequenceModalBody, UserEditor } from './Cells.tsx';
import { Modal, Popover } from './common.tsx';
import { FIELD_ICON, Icon } from './icons.tsx';

const ROW = 34;
const NUMW = 64;
export const visibleFields = (detail: TableDetail, config: ViewConfig): Field[] => {
  const [primary, ...rest] = detail.fields;
  const order = config.order ?? [];
  const sorted = [...rest].sort((a, b) => { const ia = order.indexOf(a.id), ib = order.indexOf(b.id); return (ia < 0 ? 1e6 + a.position : ia) - (ib < 0 ? 1e6 + b.position : ib); });
  return [primary, ...sorted.filter((f) => !(config.hidden ?? []).includes(f.id))];
};

type DisplayRow = { t: 'g'; label: string; count: number; key: string } | { t: 'r'; i: number };

export interface GridApi { createRecord: () => Promise<void>; reload: () => void; total: number | null; selectAll: () => Promise<void> }

export function Grid({ tableId, detail, config, setConfig, spec, canEdit, onOpen, selected, setSelected, onEditField, apiRef, onTotal }: {
  tableId: string; detail: TableDetail; config: ViewConfig; setConfig: (c: ViewConfig) => void; spec: QSpec; canEdit: boolean; onOpen: (id: string) => void;
  selected: Set<string>; setSelected: (s: Set<string>) => void; onEditField: (f: Field) => void; apiRef?: { current: GridApi | null }; onTotal?: (n: number | null) => void;
}) {
  const { total, groups, rowAt, ensure, error, refresh, patchLocal } = useRecordPages(tableId, spec);
  useEffect(() => { onTotal?.(total); }, [total]); // eslint-disable-line react-hooks/exhaustive-deps
  const cols = useMemo(() => visibleFields(detail, config), [detail, config]);
  const [live, setLive] = useState<Record<string, number>>({});
  const width = (f: Field) => live[f.id] ?? config.widths?.[f.id] ?? COL_WIDTH[f.type] ?? 160;
  const totalW = NUMW + cols.reduce((s, f) => s + width(f), 0) + 40;
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 600 });
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ recordId: string; field: Field; initial?: string; cellEl: HTMLElement | null } | null>(null);
  const [seqModal, setSeqModal] = useState<{ recordId: string; field: Field; text: string } | null>(null);
  const [menu, setMenu] = useState<{ field: Field; el: HTMLElement } | null>(null);

  // ---- display model (group headers interleaved with records) ----
  const model = useMemo(() => {
    if (total === null) return { count: 0, at: (_k: number): DisplayRow => ({ t: 'r', i: 0 }) };
    if (!groups?.length || !spec.groupBy) return { count: total, at: (k: number): DisplayRow => ({ t: 'r', i: k }) };
    const starts: number[] = [], recStarts: number[] = [];
    let rec = 0;
    groups.forEach((g, gi) => { starts.push(rec + gi); recStarts.push(rec); rec += g.count; });
    return {
      count: total + groups.length,
      at: (k: number): DisplayRow => {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= k) lo = mid; else hi = mid - 1; }
        return k === starts[lo] ? { t: 'g', label: groups[lo].label, count: groups[lo].count, key: groups[lo].key } : { t: 'r', i: recStarts[lo] + (k - starts[lo] - 1) };
      },
    };
  }, [total, groups, spec.groupBy]);

  const first = Math.max(0, Math.floor((view.top - ROW) / ROW) - 6);
  const last = Math.min(model.count - 1, Math.ceil((view.top + view.h) / ROW) + 6);
  useEffect(() => {
    // fetch the record pages that the visible display rows map to
    if (total === null || last < first) return;
    const a = model.at(first), b = model.at(last);
    const lo = a.t === 'r' ? a.i : model.at(Math.min(last, first + 1)).t === 'r' ? (model.at(first + 1) as { i: number }).i : 0;
    const hi = b.t === 'r' ? b.i : Math.max(lo, (model.at(Math.max(first, last - 1)) as { i: number }).i ?? lo);
    ensure(lo, hi);
  }, [first, last, total, model, ensure]);

  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, h: el.clientHeight })));
    ro.observe(el); setView({ top: el.scrollTop, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ---- editing ----
  const canEditField = (f: Field) => canEdit && !NOT_EDITABLE.has(f.type);
  const commit = useCallback(async (rec: RecordRow, f: Field, value: unknown, optimistic = true) => {
    setEditing(null);
    const prev = rec.fields[f.id];
    const simple = ['text', 'longtext', 'number', 'url', 'date', 'checkbox'].includes(f.type);
    if (simple && optimistic) patchLocal(rec.id, { [f.id]: value === null && f.type !== 'checkbox' ? undefined : value });
    try {
      const r = await patch(`/api/records/${rec.id}`, { fields: { [f.id]: value }, createChoices: true });
      patchLocal(rec.id, r.record.fields);
    } catch (e) {
      toast((e as Error).message, 'err');
      if (simple) patchLocal(rec.id, { [f.id]: prev });
      refresh();
    }
  }, [patchLocal, refresh]);

  const startEdit = (rec: RecordRow, f: Field, initial?: string, el?: HTMLElement | null) => {
    if (!canEditField(f)) { if (f.type === 'structure' || f.type === 'attachment' || f.type === 'relation') onOpen(rec.id); return; }
    if (f.type === 'checkbox') { void commit(rec, f, !rec.fields[f.id]); return; }
    if (f.type === 'sequence') { setSeqModal({ recordId: rec.id, field: f, text: String(rec.fields[f.id] ?? '') }); return; }
    if (f.type === 'structure' || f.type === 'attachment') { onOpen(rec.id); return; }
    if (f.type === 'longtext') { onOpen(rec.id); return; }
    setEditing({ recordId: rec.id, field: f, initial, cellEl: el ?? null });
  };

  // ---- keyboard ----
  const recAtDisplay = (k: number): RecordRow | undefined => { const d = model.at(k); return d.t === 'r' ? rowAt(d.i) : undefined; };
  const moveActive = (dr: number, dc: number) => {
    setActive((a) => {
      if (!a) return { r: 0, c: 0 };
      let r = Math.max(0, Math.min(model.count - 1, a.r + dr));
      while (r > 0 && r < model.count - 1 && model.at(r).t === 'g') r += dr || 1;
      const c = Math.max(0, Math.min(cols.length - 1, a.c + dc));
      const el = scroller.current;
      if (el) { const y = (r + 1) * ROW; if (y < el.scrollTop + ROW * 2) el.scrollTop = Math.max(0, y - ROW * 2); else if (y > el.scrollTop + el.clientHeight - ROW) el.scrollTop = y - el.clientHeight + ROW * 2; }
      return { r, c };
    });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (editing || seqModal) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1, 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1, 0); }
    else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); moveActive(0, 1); }
    else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); moveActive(0, -1); }
    else if (active && (e.key === 'Enter' || e.key === 'F2')) { e.preventDefault(); const rec = recAtDisplay(active.r); if (rec) startEdit(rec, cols[active.c], undefined, cellEls.current.get(`${active.r}:${active.c}`)); }
    else if (active && e.key === ' ' ) { const rec = recAtDisplay(active.r); if (rec) { e.preventDefault(); if (cols[active.c].type === 'checkbox') void commit(rec, cols[active.c], !rec.fields[cols[active.c].id]); else onOpen(rec.id); } }
    else if (active && (e.key === 'Delete' || e.key === 'Backspace')) { const rec = recAtDisplay(active.r); const f = cols[active.c]; if (rec && canEditField(f) && f.type !== 'sequence') { e.preventDefault(); void commit(rec, f, f.type === 'checkbox' ? false : f.type === 'multiSelect' || f.type === 'relation' ? [] : null); } }
    else if (active && mod && e.key.toLowerCase() === 'c') { const rec = recAtDisplay(active.r); if (rec) void navigator.clipboard?.writeText(cellText(rec.fields[cols[active.c].id], cols[active.c])); }
    else if (active && !mod && e.key.length === 1 && ['text', 'number', 'url'].includes(cols[active.c].type)) { const rec = recAtDisplay(active.r); if (rec) { e.preventDefault(); startEdit(rec, cols[active.c], e.key, cellEls.current.get(`${active.r}:${active.c}`)); } }
  };
  const cellEls = useRef(new Map<string, HTMLElement>());

  // ---- column resize ----
  const startResize = (e: React.MouseEvent, f: Field) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = width(f);
    let w = w0;
    const mv = (ev: MouseEvent) => { w = Math.max(70, Math.min(900, w0 + ev.clientX - x0)); setLive((l) => ({ ...l, [f.id]: w })); };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); setLive((l) => { const { [f.id]: _, ...r } = l; return r; }); setConfig({ ...config, widths: { ...(config.widths ?? {}), [f.id]: w } }); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  };

  // ---- creating rows ----
  const createRecord = useCallback(async () => {
    try {
      const r = await post(`/api/tables/${tableId}/records`, { fields: {} });
      refresh();
      setTimeout(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, 250);
      return r;
    } catch (e) { toast((e as Error).message, 'err'); }
  }, [tableId, refresh]);
  const selectAll = useCallback(async () => {
    const r = await post(`/api/tables/${tableId}/query`, { ...spec, offset: 0, limit: 5000, fieldIds: [] });
    setSelected(new Set(r.records.map((x: RecordRow) => x.id)));
  }, [tableId, spec, setSelected]);
  useEffect(() => { if (apiRef) apiRef.current = { createRecord: async () => { await createRecord(); }, reload: refresh, total, selectAll }; });

  const rows: React.ReactNode[] = [];
  for (let k = first; k <= last && total !== null; k++) {
    const d = model.at(k);
    if (d.t === 'g') { rows.push(<div key={`g${k}`} className="r group" style={{ top: k * ROW, height: ROW }}><Icon name="chevD" size={14} />{d.label}<span className="chip">{d.count}</span></div>); continue; }
    const rec = rowAt(d.i);
    const sel = !!rec && selected.has(rec.id);
    rows.push(
      <div key={k} className={`r${sel ? ' sel' : ''}`} style={{ top: k * ROW }} role="row">
        <div className="cell num" style={{ width: NUMW }}>
          {rec && <input type="checkbox" checked={sel} onChange={() => { const n = new Set(selected); sel ? n.delete(rec.id) : n.add(rec.id); setSelected(n); }} aria-label={`Select row ${d.i + 1}`} />}
          <span style={{ minWidth: 18, textAlign: 'center' }}>{d.i + 1}</span>
          {rec && <button className="xp" onClick={() => onOpen(rec.id)} aria-label="Open record" title="Open record"><Icon name="expand" size={14} /></button>}
        </div>
        {cols.map((f, c) => {
          const isAct = active?.r === k && active.c === c;
          return (
            <div key={f.id} role="gridcell" className={`cell${c === 0 ? ' pin' : ''}${isAct ? ' act' : ''}`} style={{ width: width(f), left: c === 0 ? NUMW : undefined }}
              ref={(el) => { if (el) cellEls.current.set(`${k}:${c}`, el); else cellEls.current.delete(`${k}:${c}`); }}
              onMouseDown={() => { setActive({ r: k, c }); scroller.current?.focus({ preventScroll: true }); }}
              onDoubleClick={(e) => rec && startEdit(rec, f, undefined, e.currentTarget)}
              onClick={(e) => { if (rec && f.type === 'checkbox' && canEditField(f)) void commit(rec, f, !rec.fields[f.id]); else if (rec && isAct && ['singleSelect', 'multiSelect', 'status', 'user', 'relation'].includes(f.type) && canEditField(f)) startEdit(rec, f, undefined, e.currentTarget); }}>
              {rec ? <CellView field={f} value={rec.fields[f.id]} compact /> : c === 0 ? <span className="muted">…</span> : null}
              {editing && rec && editing.recordId === rec.id && editing.field.id === f.id && ['text', 'number', 'url', 'date'].includes(f.type) && (
                <InlineInput field={f} value={rec.fields[f.id]} initial={editing.initial} onCommit={(v) => void commit(rec, f, v)} onCancel={() => setEditing(null)} />
              )}
            </div>
          );
        })}
      </div>,
    );
  }

  const editRec = editing ? findRec(editing.recordId) : undefined;
  function findRec(id: string): RecordRow | undefined { for (let k = first; k <= last; k++) { const d = model.at(k); if (d.t === 'r') { const r = rowAt(d.i); if (r?.id === id) return r; } } return undefined; }
  const anchorRef = useMemo(() => ({ current: editing?.cellEl ?? null }), [editing]);

  if (error) return <div className="empty"><b>Could not load records</b>{error}<br /><button className="btn secondary sm" style={{ marginTop: 8 }} onClick={refresh}>Retry</button></div>;
  return (
    <div className="grid" ref={scroller} tabIndex={0} onKeyDown={onKey} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })} role="grid" aria-rowcount={total ?? undefined} aria-label="Records">
      <div className="hdr" style={{ width: totalW }}>
        <div className="hc num" style={{ width: NUMW }}>
          <input type="checkbox" aria-label="Select all loaded rows" checked={!!total && selected.size > 0 && selected.size >= Math.min(total, 5000)} onChange={(e) => (e.target.checked ? void selectAll() : setSelected(new Set()))} />
        </div>
        {cols.map((f, c) => {
          const s = config.sorts?.find((x) => x.field === f.id);
          return (
            <div key={f.id} className={`hc${c === 0 ? ' pin' : ''}`} style={{ width: width(f), left: c === 0 ? NUMW : undefined }} onClick={(e) => setMenu({ field: f, el: e.currentTarget })} role="columnheader" aria-sort={s ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
              <span className="ti"><Icon name={FIELD_ICON[f.type] ?? 'text'} size={14} /></span><span className="nm">{f.name}</span>
              {s && <Icon name={s.dir === 'asc' ? 'chevU' : 'chevD'} size={13} />}
              <span className="rz" onMouseDown={(e) => startResize(e, f)} onClick={(e) => e.stopPropagation()} />
            </div>
          );
        })}
        {canEdit && <div className="hc" style={{ width: 40, justifyContent: 'center' }} onClick={() => onEditField(undefined as unknown as Field)} title="Add field" role="button" aria-label="Add field"><Icon name="plus" size={15} /></div>}
      </div>
      <div className="rows" style={{ height: model.count * ROW + ROW * 2, width: totalW }}>
        {total === 0 && <div style={{ position: 'sticky', left: 0, width: '100%' }}><div className="empty"><b>No records</b>{spec.filter || spec.search ? 'Nothing matches the current filters.' : 'Add a record, import a CSV, or search a scientific database to get started.'}</div></div>}
        {total === null && <div className="empty"><span className="spinner" /> Loading…</div>}
        {rows}
        {canEdit && total !== null && <button className="add" style={{ position: 'absolute', top: model.count * ROW, height: ROW }} onClick={() => void createRecord()}><Icon name="plus" size={14} />&nbsp; New record</button>}
      </div>

      {editing && editRec && ['singleSelect', 'multiSelect', 'status'].includes(editing.field.type) && <SelectEditor anchor={anchorRef} field={editing.field} value={editRec.fields[editing.field.id]} onCommit={(v) => void commit(editRec, editing.field, v, false)} onClose={() => setEditing(null)} />}
      {editing && editRec && editing.field.type === 'user' && <UserEditor anchor={anchorRef} value={editRec.fields[editing.field.id]} onCommit={(v) => void commit(editRec, editing.field, v, false)} onClose={() => setEditing(null)} />}
      {editing && editRec && editing.field.type === 'relation' && <RelationEditor anchor={anchorRef} field={editing.field} value={editRec.fields[editing.field.id]} onCommit={(ids) => void commit(editRec, editing.field, ids, false)} onClose={() => setEditing(null)} />}
      {seqModal && (
        <Modal title={`Edit ${seqModal.field.name}`} onClose={() => setSeqModal(null)} footer={<><button className="btn secondary" onClick={() => setSeqModal(null)}>Cancel</button><button className="btn" onClick={() => { const rec = findRec(seqModal.recordId); if (rec) void commit(rec, seqModal.field, seqModal.text.replace(/^>.*$/gm, '').replace(/\s+/g, '') || null, false); setSeqModal(null); }}>Save</button></>}>
          <SequenceModalBody value={seqModal.text} seqType={seqModal.field.options.seqType} onChange={(t) => setSeqModal({ ...seqModal, text: t })} />
        </Modal>
      )}
      {menu && (
        <Popover anchor={menu.el} onClose={() => setMenu(null)} width={230}>
          <button className="item" onClick={() => { setConfig({ ...config, sorts: [{ field: menu.field.id, dir: 'asc' }] }); setMenu(null); }}><Icon name="sort" /> Sort A → Z</button>
          <button className="item" onClick={() => { setConfig({ ...config, sorts: [{ field: menu.field.id, dir: 'desc' }] }); setMenu(null); }}><Icon name="sort" /> Sort Z → A</button>
          <button className="item" onClick={() => { setConfig({ ...config, groupBy: { field: menu.field.id, dir: 'asc' } }); setMenu(null); }}><Icon name="group" /> Group by this field</button>
          {menu.field.id !== detail.fields[0].id && <button className="item" onClick={() => { setConfig({ ...config, hidden: [...(config.hidden ?? []), menu.field.id] }); setMenu(null); }}><Icon name="eyeoff" /> Hide field</button>}
          {canEdit && <><hr /><button className="item" onClick={() => { onEditField(menu.field); setMenu(null); }}><Icon name="cog" /> Edit field…</button></>}
        </Popover>
      )}
    </div>
  );
}
