import { useMemo, useState } from 'react';
import type { Field, RecordRow, ViewConfig } from '../../shared/types.ts';
import { cellText } from '../../shared/filters.ts';
import { patch, post } from '../lib/api.ts';
import { useAllRecords } from '../lib/data.ts';
import type { QSpec } from '../lib/data.ts';
import { toast } from '../lib/store.ts';
import type { TableDetail } from '../lib/store.ts';
import { CellView, choiceOf } from './Cells.tsx';
import { Chip, Empty, fmtDate } from './common.tsx';
import { KIND_ICON, Icon } from './icons.tsx';

interface VP { tableId: string; detail: TableDetail; config: ViewConfig; spec: QSpec; canEdit: boolean; onOpen: (id: string) => void }
const primary = (d: TableDetail) => d.fields[0];
const title = (d: TableDetail, r: RecordRow) => cellText(r.fields[primary(d).id], primary(d)) || '(unnamed)';
const shown = (d: TableDetail, c: ViewConfig, n: number): Field[] => {
  const pool = d.fields.slice(1).filter((f) => !(c.hidden ?? []).includes(f.id) && !['longtext', 'attachment'].includes(f.type));
  const pick = c.cardFields?.length ? pool.filter((f) => c.cardFields!.includes(f.id)) : pool;
  return pick.slice(0, n);
};

// ---------------------------------------------------------------- Kanban
export function Kanban({ tableId, detail, config, setConfig, spec, canEdit, onOpen }: VP & { setConfig: (c: ViewConfig) => void }) {
  const fieldId = config.kanbanField;
  const f = detail.fields.find((x) => x.id === fieldId);
  const { data, error, patchLocal, reload } = useAllRecords(tableId, { ...spec, groupBy: undefined, sorts: spec.sorts }, 2000, !!f);
  const [over, setOver] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const selectFields = detail.fields.filter((x) => x.type === 'status' || x.type === 'singleSelect');
  if (!f) return (
    <div className="empty"><b>Choose how to organise the board</b>Pick a Status or Single select field to use as columns.<br />
      <select className="select" style={{ width: 240, marginTop: 10 }} value="" onChange={(e) => setConfig({ ...config, kanbanField: e.target.value })} aria-label="Board field"><option value="" disabled>Choose a field…</option>{selectFields.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      {!selectFields.length && <p className="small">This table has no Status or Single select field yet. Add one from the field menu.</p>}
    </div>
  );
  const choices = f.options.choices ?? [];
  const cols = [...choices.map((c) => ({ id: c.id, name: c.name, color: c.color })), { id: '', name: 'No ' + f.name.toLowerCase(), color: 'gray' as const }];
  const by = new Map<string, RecordRow[]>();
  for (const r of data?.records ?? []) { const k = (r.fields[f.id] as string | undefined) ?? ''; by.set(k, [...(by.get(k) ?? []), r]); }
  const move = async (id: string, to: string) => {
    patchLocal(id, { [f.id]: to || undefined });
    try { await patch(`/api/records/${id}`, { fields: { [f.id]: to || null } }); } catch (e) { toast((e as Error).message, 'err'); reload(); }
  };
  const add = async (to: string) => { try { await post(`/api/tables/${tableId}/records`, { fields: { [f.id]: to || undefined } }); reload(); } catch (e) { toast((e as Error).message, 'err'); } };
  if (error) return <Empty title="Could not load the board">{error}</Empty>;
  return (
    <div className="kanban">
      {cols.map((c) => (
        <div key={c.id} className={`kcol${over === c.id ? ' over' : ''}`}
          onDragOver={(e) => { if (canEdit && drag) { e.preventDefault(); setOver(c.id); } }} onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
          onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData('text/plain') || drag; if (id && canEdit) void move(id, c.id); setDrag(null); }}>
          <h3><Chip color={c.color}>{c.name}</Chip><span className="muted small">{by.get(c.id)?.length ?? 0}</span></h3>
          <div className="cards">
            {!data && <span className="muted small"><span className="spinner" /></span>}
            {(by.get(c.id) ?? []).map((r) => (
              <div key={r.id} className={`card${drag === r.id ? ' dragging' : ''}`} draggable={canEdit} tabIndex={0} role="button" aria-label={`${title(detail, r)}. Press Enter to open`}
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', r.id); e.dataTransfer.effectAllowed = 'move'; setDrag(r.id); }} onDragEnd={() => { setDrag(null); setOver(null); }}
                onClick={() => onOpen(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r.id); }}>
                <div className="ttl">{title(detail, r)}</div>
                {shown(detail, config, 3).filter((x) => x.id !== f.id).map((x) => { const v = r.fields[x.id]; return v === undefined || v === null || (Array.isArray(v) && !v.length) ? null : <div key={x.id} className="row wrap small" style={{ gap: 4 }}><CellView field={x} value={v} compact /></div>; })}
              </div>
            ))}
            {canEdit && <button className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => void add(c.id)}><Icon name="plus" /> Add</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Gallery
export function Gallery({ tableId, detail, config, spec, onOpen }: VP & { setConfig?: (c: ViewConfig) => void }) {
  const { data, error } = useAllRecords(tableId, spec, 600);
  const kind = (detail.table.kind as string) ?? 'custom';
  if (error) return <Empty title="Could not load">{error}</Empty>;
  if (!data) return <div className="empty"><span className="spinner" /></div>;
  if (!data.records.length) return <Empty title="No records" />;
  return (
    <div className="gallery">
      {data.records.map((r) => {
        const cidF = detail.fields.find((f) => f.key === 'cid'), cid = cidF ? r.fields[cidF.id] : undefined;
        const sF = detail.fields.find((f) => f.type === 'structure'), s = sF ? (r.fields[sF.id] as any) : undefined;
        const pdb = s?.source === 'pdb' ? String(s.id).toLowerCase() : null;
        return (
          <div key={r.id} className="gcard" tabIndex={0} role="button" onClick={() => onOpen(r.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(r.id)}>
            <div className="cover">
              {cid ? <img loading="lazy" alt={`Structure of ${title(detail, r)}`} src={`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/PNG?image_size=small`} />
                : pdb ? <img loading="lazy" alt={`Structure ${pdb}`} src={`https://cdn.rcsb.org/images/structures/${pdb.slice(1, 3)}/${pdb}/${pdb}_assembly-1.jpeg`} />
                : s?.predicted ? <div className="col center" style={{ gap: 2 }}><Icon name="cube" size={30} /><span className="small">pLDDT {Math.round(s.meanPlddt)} · predicted</span></div>
                : <Icon name={KIND_ICON[kind] ?? 'grid'} size={30} />}
            </div>
            <div className="gb">
              <div className="ttl" title={title(detail, r)}>{title(detail, r)}</div>
              {shown(detail, config, 3).map((f) => { const v = r.fields[f.id]; return v === undefined || v === null || (Array.isArray(v) && !v.length) ? null : <div key={f.id} className="row small" style={{ gap: 4, overflow: 'hidden' }}><span className="muted">{f.name}:</span><CellView field={f} value={v} compact /></div>; })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- List
export function ListView({ tableId, detail, config, spec, canEdit, onOpen }: VP) {
  const { data, error, reload } = useAllRecords(tableId, spec, 2000);
  const statusF = detail.fields.find((f) => f.type === 'status') ?? detail.fields.find((f) => f.type === 'singleSelect');
  const dateF = detail.fields.find((f) => f.type === 'date');
  const doneId = statusF?.options.choices?.find((c) => /^(done|completed)$/i.test(c.name))?.id;
  const firstId = statusF?.options.choices?.[0]?.id;
  if (error) return <Empty title="Could not load">{error}</Empty>;
  if (!data) return <div className="empty"><span className="spinner" /></div>;
  if (!data.records.length) return <Empty title="No records" />;
  const toggle = async (r: RecordRow) => {
    if (!statusF || !doneId) return;
    try { await patch(`/api/records/${r.id}`, { fields: { [statusF.id]: r.fields[statusF.id] === doneId ? firstId : doneId } }); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const extra = shown(detail, config, 4).filter((f) => f.id !== statusF?.id && f.id !== dateF?.id);
  return (
    <div className="listv" role="list">
      {data.records.map((r) => {
        const done = !!statusF && !!doneId && r.fields[statusF.id] === doneId;
        return (
          <div key={r.id} className="li" role="listitem" onClick={() => onOpen(r.id)}>
            {statusF && doneId && <input type="checkbox" checked={done} disabled={!canEdit} onClick={(e) => e.stopPropagation()} onChange={() => void toggle(r)} aria-label={done ? 'Mark not done' : 'Mark done'} />}
            <span className="ttl" style={done ? { textDecoration: 'line-through', color: 'var(--ink-3)' } : undefined}>{title(detail, r)}</span>
            <span className="row hide-m" style={{ gap: 4 }}>{extra.map((f) => <CellView key={f.id} field={f} value={r.fields[f.id]} compact />)}</span>
            {dateF && r.fields[dateF.id] ? <span className="small muted" style={{ minWidth: 90, textAlign: 'right' }}>{fmtDate(String(r.fields[dateF.id]))}</span> : null}
            {statusF && <span style={{ minWidth: 96 }}><CellView field={statusF} value={r.fields[statusF.id]} /></span>}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Calendar
export function Calendar({ tableId, detail, config, setConfig, spec, canEdit, onOpen }: VP & { setConfig: (c: ViewConfig) => void }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); });
  const dateFields = detail.fields.filter((f) => f.type === 'date' || f.type === 'createdTime' || f.type === 'lastModifiedTime');
  const df = detail.fields.find((f) => f.id === config.dateField);
  const start = new Date(month); start.setUTCDate(1 - ((month.getUTCDay() + 6) % 7)); // Monday first
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 41);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const rangeSpec = useMemo<QSpec>(() => df ? { ...spec, filter: { mode: 'and', items: [...(spec.filter?.items.length ? [spec.filter] : []), { field: df.id, op: 'gte', value: iso(start) }, { field: df.id, op: 'lte', value: iso(end) }] } } : spec, [spec, df, month]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, error } = useAllRecords(tableId, rangeSpec, 2000, !!df);
  if (!df) return (
    <div className="empty"><b>Choose a date field for the calendar</b>
      <select className="select" style={{ width: 240, marginTop: 10 }} value="" onChange={(e) => setConfig({ ...config, dateField: e.target.value })} aria-label="Date field"><option value="" disabled>Choose a field…</option>{dateFields.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      {!dateFields.length && <p className="small">This table has no Date field yet.</p>}
    </div>
  );
  const byDay = new Map<string, RecordRow[]>();
  for (const r of data?.records ?? []) { const k = String(r.fields[df.id] ?? '').slice(0, 10); if (k) byDay.set(k, [...(byDay.get(k) ?? []), r]); }
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setUTCDate(start.getUTCDate() + i); return d; });
  const today = iso(new Date());
  const addOn = async (day: string) => { if (!canEdit || df.type !== 'date') return; try { const r = await post(`/api/tables/${tableId}/records`, { fields: { [df.id]: day } }); onOpen(r.records[0].id); } catch (e) { toast((e as Error).message, 'err'); } };
  if (error) return <Empty title="Could not load">{error}</Empty>;
  return (
    <div className="cal">
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn secondary sm icon" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)))} aria-label="Previous month"><Icon name="chevL" /></button>
        <h2 style={{ minWidth: 150, textAlign: 'center' }}>{month.toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h2>
        <button className="btn secondary sm icon" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)))} aria-label="Next month"><Icon name="chevR" /></button>
        <button className="btn ghost sm" onClick={() => { const d = new Date(); setMonth(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))); }}>Today</button>
        <span className="grow" /><span className="muted small">Date field:</span>
        <select className="select" style={{ width: 170, minHeight: 28 }} value={df.id} onChange={(e) => setConfig({ ...config, dateField: e.target.value })} aria-label="Date field">{dateFields.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      </div>
      <div className="calgrid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="dow">{d}</div>)}
        {days.map((d) => {
          const k = iso(d), list = byDay.get(k) ?? [];
          return (
            <div key={k} className={`day${d.getUTCMonth() !== month.getUTCMonth() ? ' off' : ''}${k === today ? ' today' : ''}`} onDoubleClick={() => void addOn(k)}>
              <span className="n">{d.getUTCDate()}</span>
              {list.slice(0, 4).map((r) => <button key={r.id} className="ev1" onClick={() => onOpen(r.id)} title={title(detail, r)}>{title(detail, r)}</button>)}
              {list.length > 4 && <span className="muted small">+{list.length - 4} more</span>}
            </div>
          );
        })}
      </div>
      <p className="muted small">Double-click a day to add a record on that date.</p>
    </div>
  );
}
void choiceOf;
