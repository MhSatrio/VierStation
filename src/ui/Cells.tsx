import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { Field, RelationRef, SelectChoice } from '../../shared/types.ts';
import { cellText } from '../../shared/filters.ts';
import { Chip, EVIDENCE_COLOR, Popover, fmtBytes, fmtDate, fmtNum, useDebounced } from './common.tsx';
import { Icon } from './icons.tsx';
import { post } from '../lib/api.ts';
import { useMembers } from '../lib/data.ts';
import { Link } from '../lib/router.tsx';
import { Thumb } from './explorer/Thumb.tsx';

export const COL_WIDTH: Record<string, number> = { text: 220, longtext: 260, number: 110, singleSelect: 150, multiSelect: 190, status: 150, checkbox: 90, url: 200, attachment: 180, formula: 150, relation: 230, thumbnail: 84, lookup: 200, rollup: 130, sequence: 240, structure: 210, date: 130, createdTime: 160, lastModifiedTime: 160, user: 150 };
export const NOT_EDITABLE = new Set(['thumbnail', 'formula', 'lookup', 'rollup', 'createdTime', 'lastModifiedTime']);

export function choiceOf(f: Field, id: unknown): SelectChoice | undefined { return f.options.choices?.find((c) => c.id === id); }

/** Read-only rendering of a cell value (also used by cards, lists and the record panel). */
export function CellView({ field: f, value: v, compact }: { field: Field; value: unknown; compact?: boolean }) {
  const { byId } = useMembers();
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length && f.type !== 'checkbox')) return f.type === 'checkbox' ? <span className="muted">☐</span> : null;
  switch (f.type) {
    case 'thumbnail': return <Thumb id={String(v)} size={compact ? 28 : 44} />;
    case 'checkbox': return v ? <span style={{ color: 'var(--green)' }}>✓</span> : <span className="muted">☐</span>;
    case 'number': return <span className="rtl">{fmtNum(v, f.options.precision)}</span>;
    case 'singleSelect': case 'status': { const c = choiceOf(f, v); return c ? <Chip color={c.color}>{c.name}</Chip> : <span className="muted">{String(v)}</span>; }
    case 'multiSelect': return <>{(v as string[]).map((id) => { const c = choiceOf(f, id); return c ? <Chip key={id} color={c.color}>{c.name}</Chip> : null; })}</>;
    case 'url': return <a href={String(v)} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className="t">{String(v).replace(/^https?:\/\//, '')}</a>;
    case 'date': case 'createdTime': case 'lastModifiedTime': return <span className="t">{fmtDate(String(v), f.type !== 'date' || !!f.options.includeTime)}</span>;
    case 'sequence': { const s = String(v); return <span className="seq" title={`${s.length.toLocaleString()} ${f.options.seqType === 'protein' ? 'aa' : 'bp'}`}>{s.slice(0, compact ? 24 : 48)}{s.length > (compact ? 24 : 48) ? `… ${s.length.toLocaleString()}` : ''}</span>; }
    case 'structure': { const o = v as any; return <Chip color={o.predicted ? 'amber' : 'green'} title={o.predicted ? 'Predicted structure (not experimental)' : 'Experimental structure'}>{o.id}{o.meanPlddt ? ` · pLDDT ${Math.round(o.meanPlddt)}` : o.resolution ? ` · ${o.resolution} Å` : ''}</Chip>; }
    case 'attachment': return <>{(v as { id: string; name: string; size: number }[]).map((a) => <a key={a.id} className="chip blue link" href={`/api/files/${a.id}`} onClick={(e) => e.stopPropagation()} title={fmtBytes(a.size)}><Icon name="paperclip" size={11} />{a.name}</a>)}</>;
    case 'relation': return <RelChips refs={v as RelationRef[]} />;
    case 'user': return <span className="t">{byId.get(String(v))?.name ?? '…'}</span>;
    case 'lookup': return <span className="t">{(v as unknown[]).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ')}</span>;
    case 'rollup': case 'formula': return typeof v === 'number' ? <span className="rtl">{fmtNum(v, f.options.precision)}</span> : <span className="t">{String(v)}</span>;
    default: return <span className="t">{compact ? String(v).replace(/\s+/g, ' ') : String(v)}</span>;
  }
}

export function RelChips({ refs, onOpen }: { refs: RelationRef[]; onOpen?: (id: string) => void }) {
  return (
    <>{refs.map((r) => (
      <Chip key={r.id} color="sky" title={r.meta?.evidenceClass ? `${r.meta.evidenceClass.replace(/_/g, ' ')}${r.meta.relationType ? ' · ' + r.meta.relationType : ''}` : undefined} onClick={onOpen ? () => onOpen(r.id) : undefined}>
        {r.meta?.evidenceClass && <i style={{ width: 7, height: 7, borderRadius: '50%', background: EVIDENCE_COLOR[r.meta.evidenceClass], display: 'inline-block', flex: 'none' }} />}{r.name}
      </Chip>
    ))}</>
  );
}

// ---------------- inline input editors ----------------
export function InlineInput({ field: f, value, onCommit, onCancel, initial }: { field: Field; value: unknown; onCommit: (v: unknown) => void; onCancel: () => void; initial?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const type = f.type === 'number' ? 'number' : f.type === 'date' ? (f.options.includeTime ? 'datetime-local' : 'date') : 'text';
  const start = initial !== undefined ? initial : f.type === 'date' ? (value ? String(value).slice(0, f.options.includeTime ? 16 : 10) : '') : value === null || value === undefined ? '' : String(value);
  const [text, setText] = useState(start);
  useEffect(() => { ref.current?.focus(); if (initial === undefined) ref.current?.select(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const done = useRef(false);
  const commit = () => { if (done.current) return; done.current = true; onCommit(text === '' ? null : f.type === 'number' ? Number(text) : text); };
  return (
    <div className="cell-edit">
      <input ref={ref} type={type} step={f.type === 'number' ? 'any' : undefined} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.stopPropagation(); done.current = true; onCancel(); } else if (e.key === 'Tab') commit(); }} aria-label={f.name} />
    </div>
  );
}

// ---------------- popover editors ----------------
export function SelectEditor({ anchor, field: f, value, onCommit, onClose }: { anchor: RefObject<HTMLElement | null>; field: Field; value: unknown; onCommit: (v: unknown) => void; onClose: () => void }) {
  const multi = f.type === 'multiSelect';
  const [q, setQ] = useState('');
  const choices = (f.options.choices ?? []).filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  const sel = new Set(multi ? (value as string[] | null) ?? [] : value ? [String(value)] : []);
  const toggle = (id: string) => {
    if (multi) { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); onCommit([...n]); }
    else { onCommit(sel.has(id) ? null : id); onClose(); }
  };
  const exact = (f.options.choices ?? []).some((c) => c.name.toLowerCase() === q.trim().toLowerCase());
  return (
    <Popover anchor={anchor} onClose={onClose} width={250}>
      <input className="input" autoFocus placeholder={multi ? 'Search or add option…' : 'Search or add option…'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search options"
        onKeyDown={(e) => { if (e.key === 'Enter') { const hit = choices[0]; if (hit) toggle(hit.id); else if (q.trim()) { onCommit(multi ? [...sel, q.trim()] : q.trim()); if (!multi) onClose(); } } }} />
      <div style={{ marginTop: 4 }}>
        {choices.map((c) => <button key={c.id} className={`item${sel.has(c.id) ? ' sel' : ''}`} onClick={() => toggle(c.id)}><Chip color={c.color}>{c.name}</Chip>{sel.has(c.id) && <Icon name="check" size={14} />}</button>)}
        {q.trim() && !exact && f.type !== 'status' && <button className="item" onClick={() => { onCommit(multi ? [...sel, q.trim()] : q.trim()); if (!multi) onClose(); }}><Icon name="plus" size={14} /> Create “{q.trim()}”</button>}
        {!choices.length && !q.trim() && <div className="muted small" style={{ padding: 6 }}>No options yet. Type to add one.</div>}
        {sel.size > 0 && !multi && <><hr /><button className="item" onClick={() => { onCommit(null); onClose(); }}><Icon name="x" size={14} /> Clear</button></>}
      </div>
    </Popover>
  );
}

export function UserEditor({ anchor, value, onCommit, onClose }: { anchor: RefObject<HTMLElement | null>; value: unknown; onCommit: (v: unknown) => void; onClose: () => void }) {
  const { members } = useMembers();
  return (
    <Popover anchor={anchor} onClose={onClose} width={240}>
      {members.map((m) => <button key={m.id} className={`item${value === m.id ? ' sel' : ''}`} onClick={() => { onCommit(m.id); onClose(); }}><span className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>{m.name.slice(0, 1)}</span><span>{m.name}<br /><span className="muted small">{m.email}</span></span></button>)}
      {value ? <><hr /><button className="item" onClick={() => { onCommit(null); onClose(); }}><Icon name="x" size={14} /> Unassign</button></> : null}
    </Popover>
  );
}

/** Pick records from the linked table (full-text search, multi-select). Keeps the evidence of links that stay. */
export function RelationEditor({ anchor, field: f, value, onCommit, onClose }: { anchor: RefObject<HTMLElement | null>; field: Field; value: unknown; onCommit: (ids: string[]) => void; onClose: () => void }) {
  const cur = (value as RelationRef[] | null) ?? [];
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [ids, setIds] = useState<string[]>(cur.map((c) => c.id));
  return <RelationPicker anchor={anchor} target={f.options.targetTable!} selected={cur} q={q} setQ={setQ} dq={dq} ids={ids} setIds={setIds} onCommit={onCommit} onClose={onClose} />;
}

function RelationPicker({ anchor, target, selected, q, setQ, dq, ids, setIds, onCommit, onClose }: { anchor: RefObject<HTMLElement | null>; target: string; selected: RelationRef[]; q: string; setQ: (s: string) => void; dq: string; ids: string[]; setIds: (i: string[]) => void; onCommit: (ids: string[]) => void; onClose: () => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(true);
  const known = useMemo(() => new Map(selected.map((s) => [s.id, s.name])), [selected]);
  useEffect(() => {
    let live = true;
    setBusy(true);
    post(`/api/tables/${target}/query`, { search: dq || undefined, limit: 30 }).then(async (r) => {
      // the primary field is the table's first field; fetch field order to label rows
      const detail = await import('../lib/store.ts').then((m) => m.loadTable(target));
      const pf = detail.fields[0].id;
      const ch = detail.fields[0];
      if (live) setList(r.records.map((x: any) => ({ id: x.id, name: cellText(x.fields[pf], ch) || '(unnamed)' })));
    }).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [dq, target]);
  const toggle = (id: string) => setIds(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const changed = JSON.stringify([...ids].sort()) !== JSON.stringify(selected.map((s) => s.id).sort());
  return (
    <Popover anchor={anchor} onClose={() => { onClose(); }} width={300}>
      <input className="input" autoFocus placeholder="Search records to link…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search records" />
      <div style={{ maxHeight: 240, overflow: 'auto', marginTop: 4 }}>
        {busy && !list.length && <div className="muted small" style={{ padding: 8 }}><span className="spinner" /> Searching…</div>}
        {list.map((r) => <button key={r.id} className={`item${ids.includes(r.id) ? ' sel' : ''}`} onClick={() => toggle(r.id)}><span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>{ids.includes(r.id) && <Icon name="check" size={14} />}</button>)}
        {!busy && !list.length && <div className="muted small" style={{ padding: 8 }}>No matching records.</div>}
        {ids.filter((i) => !list.some((l) => l.id === i)).map((i) => <button key={i} className="item sel" onClick={() => toggle(i)}><span className="grow">{known.get(i) ?? i}</span><Icon name="check" size={14} /></button>)}
      </div>
      <hr />
      <div className="row between"><span className="muted small">{ids.length} linked</span><span className="row"><button className="btn ghost sm" onClick={onClose}>Cancel</button><button className="btn sm" disabled={!changed} onClick={() => { onCommit(ids); onClose(); }}>Apply</button></span></div>
    </Popover>
  );
}

export function SequenceModalBody({ value, seqType, onChange }: { value: string; seqType?: string; onChange: (s: string) => void }) {
  return (
    <div className="col">
      <textarea className="textarea mono" rows={10} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} aria-label="Sequence" />
      <span className="muted small">{value.replace(/[^A-Za-z*]/g, '').length.toLocaleString()} {seqType === 'protein' ? 'residues' : 'bases'} · FASTA headers and whitespace are removed automatically.</span>
    </div>
  );
}

export function LinkToRecord({ id, children }: { id: string; children: ReactNode }) { return <Link to={`/record/${id}`}>{children}</Link>; }
