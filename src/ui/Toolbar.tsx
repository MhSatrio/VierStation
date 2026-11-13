import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Field, FilterCondition, FilterGroup, FilterOp, SortSpec, ViewConfig } from '../../shared/types.ts';
import { isGroup } from '../../shared/filters.ts';
import { Chip, MenuButton } from './common.tsx';
import { FIELD_ICON, Icon } from './icons.tsx';
import { useMembers } from '../lib/data.ts';

const OP_LABEL: Record<FilterOp, string> = {
  is: 'is', isNot: 'is not', contains: 'contains', notContains: 'does not contain', startsWith: 'starts with', endsWith: 'ends with', isEmpty: 'is empty', isNotEmpty: 'is not empty',
  gt: '>', gte: '≥', lt: '<', lte: '≤', hasAny: 'has any of', hasAll: 'has all of', hasNone: 'has none of', isTrue: 'is checked', isFalse: 'is unchecked', before: 'is before', after: 'is after',
};
const TEXT_OPS: FilterOp[] = ['contains', 'notContains', 'is', 'isNot', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty'];
const NUM_OPS: FilterOp[] = ['is', 'isNot', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'];
export function opsFor(f: Field): FilterOp[] {
  switch (f.type) {
    case 'number': case 'rollup': return NUM_OPS;
    case 'formula': return [...NUM_OPS.slice(0, 6), ...TEXT_OPS.slice(0, 2), 'isEmpty', 'isNotEmpty'];
    case 'singleSelect': case 'status': case 'user': return ['is', 'isNot', 'isEmpty', 'isNotEmpty'];
    case 'multiSelect': return ['hasAny', 'hasAll', 'hasNone', 'isEmpty', 'isNotEmpty'];
    case 'checkbox': return ['isTrue', 'isFalse'];
    case 'date': case 'createdTime': case 'lastModifiedTime': return ['is', 'before', 'after', 'isEmpty', 'isNotEmpty'];
    case 'relation': case 'lookup': return ['contains', 'notContains', 'isEmpty', 'isNotEmpty'];
    case 'attachment': case 'structure': return ['isEmpty', 'isNotEmpty'];
    default: return TEXT_OPS;
  }
}
const needsValue = (op: FilterOp) => !['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'].includes(op);

function ValueInput({ f, c, onChange }: { f: Field; c: FilterCondition; onChange: (v: unknown) => void }) {
  const { members } = useMembers();
  if (!needsValue(c.op)) return null;
  if (f.type === 'singleSelect' || f.type === 'status') return <select className="select" value={String(c.value ?? '')} onChange={(e) => onChange(e.target.value)} aria-label="Value"><option value="">Choose…</option>{f.options.choices?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>;
  if (f.type === 'multiSelect') return <select className="select" multiple size={3} value={(c.value as string[]) ?? []} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))} aria-label="Values">{f.options.choices?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>;
  if (f.type === 'user') return <select className="select" value={String(c.value ?? '')} onChange={(e) => onChange(e.target.value)} aria-label="Value"><option value="">Choose…</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>;
  const t = ['date', 'createdTime', 'lastModifiedTime'].includes(f.type) ? 'date' : ['number', 'rollup'].includes(f.type) ? 'number' : 'text';
  return <input className="input" type={t} step="any" value={String(c.value ?? '')} onChange={(e) => onChange(t === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)} aria-label="Value" />;
}

export function FilterButton({ fields, config, setConfig }: { fields: Field[]; config: ViewConfig; setConfig: (c: ViewConfig) => void }) {
  const g: FilterGroup = config.filter ?? { mode: 'and', items: [] };
  const items = g.items.filter((i): i is FilterCondition => !isGroup(i));
  const upd = (next: FilterGroup) => setConfig({ ...config, filter: next.items.length ? next : undefined });
  const n = items.length;
  return (
    <MenuButton icon="filter" className={`btn secondary sm${n ? ' active' : ''}`} label={n ? `${n} filter${n > 1 ? 's' : ''}` : 'Filter'}>
      {() => (
        <div style={{ width: 'min(560px, 90vw)', padding: 6 }} className="col">
          {!n && <div className="muted small">No filters. Add a condition to narrow this view.</div>}
          {items.map((c, i) => {
            const f = fields.find((x) => x.id === c.field) ?? fields[0];
            const setItem = (p: Partial<FilterCondition>) => upd({ ...g, items: items.map((x, j) => (j === i ? { ...x, ...p } : x)) });
            return (
              <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
                <span style={{ width: 52, paddingTop: 6 }} className="muted small">{i === 0 ? 'Where' : <select className="select" style={{ minHeight: 28, padding: '0 2px' }} value={g.mode} onChange={(e) => upd({ ...g, mode: e.target.value as 'and' | 'or' })} aria-label="Combine with"><option value="and">and</option><option value="or">or</option></select>}</span>
                <select className="select" style={{ width: 150 }} value={c.field} onChange={(e) => { const nf = fields.find((x) => x.id === e.target.value)!; setItem({ field: nf.id, op: opsFor(nf)[0], value: undefined }); }} aria-label="Field">{fields.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                <select className="select" style={{ width: 140 }} value={c.op} onChange={(e) => setItem({ op: e.target.value as FilterOp })} aria-label="Operator">{opsFor(f).map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}</select>
                <div className="grow"><ValueInput f={f} c={c} onChange={(v) => setItem({ value: v })} /></div>
                <button className="btn ghost icon sm" onClick={() => upd({ ...g, items: items.filter((_, j) => j !== i) })} aria-label="Remove filter"><Icon name="x" /></button>
              </div>
            );
          })}
          <div className="row"><button className="btn secondary sm" onClick={() => upd({ ...g, items: [...items, { field: fields[0].id, op: opsFor(fields[0])[0] }] })}><Icon name="plus" /> Add condition</button>{n > 0 && <button className="btn ghost sm" onClick={() => upd({ ...g, items: [] })}>Clear all</button>}</div>
        </div>
      )}
    </MenuButton>
  );
}

export function SortButton({ fields, config, setConfig }: { fields: Field[]; config: ViewConfig; setConfig: (c: ViewConfig) => void }) {
  const sorts = config.sorts ?? [];
  const upd = (s: SortSpec[]) => setConfig({ ...config, sorts: s.length ? s : undefined });
  return (
    <MenuButton icon="sort" className={`btn secondary sm${sorts.length ? ' active' : ''}`} label={sorts.length ? `Sorted by ${sorts.length} field${sorts.length > 1 ? 's' : ''}` : 'Sort'}>
      {() => (
        <div style={{ width: 'min(420px, 90vw)', padding: 6 }} className="col">
          {sorts.map((s, i) => (
            <div key={i} className="row">
              <select className="select" value={s.field} onChange={(e) => upd(sorts.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} aria-label="Sort field">{fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
              <select className="select" style={{ width: 130 }} value={s.dir} onChange={(e) => upd(sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)))} aria-label="Direction"><option value="asc">A → Z / low → high</option><option value="desc">Z → A / high → low</option></select>
              <button className="btn ghost icon sm" onClick={() => upd(sorts.filter((_, j) => j !== i))} aria-label="Remove sort"><Icon name="x" /></button>
            </div>
          ))}
          <button className="btn secondary sm" style={{ alignSelf: 'flex-start' }} onClick={() => upd([...sorts, { field: fields.find((f) => !sorts.some((s) => s.field === f.id))?.id ?? fields[0].id, dir: 'asc' }])}><Icon name="plus" /> Add sort</button>
        </div>
      )}
    </MenuButton>
  );
}

export function GroupButton({ fields, config, setConfig }: { fields: Field[]; config: ViewConfig; setConfig: (c: ViewConfig) => void }) {
  const g = config.groupBy;
  const f = fields.find((x) => x.id === g?.field);
  return (
    <MenuButton icon="group" className={`btn secondary sm${g ? ' active' : ''}`} label={f ? `Grouped by ${f.name}` : 'Group'}>
      {(close) => (
        <div style={{ width: 260 }}>
          {fields.filter((x) => !['attachment', 'structure', 'sequence'].includes(x.type)).map((x) => <button key={x.id} className={`item${g?.field === x.id ? ' sel' : ''}`} onClick={() => { setConfig({ ...config, groupBy: { field: x.id, dir: g?.dir ?? 'asc' } }); close(); }}><Icon name={FIELD_ICON[x.type] ?? 'text'} /> {x.name}</button>)}
          {g && <><hr /><button className="item" onClick={() => { setConfig({ ...config, groupBy: undefined }); close(); }}><Icon name="x" /> No grouping</button></>}
        </div>
      )}
    </MenuButton>
  );
}

export function Searchbar({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <div className="row" style={{ position: 'relative' }}>
      <input className="input" style={{ width: 190, minHeight: 28, paddingLeft: 28 }} placeholder="Search this table…" value={v} onChange={(e) => { setV(e.target.value); onChange(e.target.value); }} aria-label="Search this table" />
      <span style={{ position: 'absolute', left: 8, color: 'var(--ink-3)', display: 'flex' }}><Icon name="search" size={14} /></span>
    </div>
  );
}

export function ViewSummary({ total, children }: { total: number | null; children?: ReactNode }) {
  return <span className="count">{total === null ? '…' : `${total.toLocaleString()} record${total === 1 ? '' : 's'}`}{children}</span>;
}
export { Chip };
