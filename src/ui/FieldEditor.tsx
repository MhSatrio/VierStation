import { useEffect, useState } from 'react';
import { FIELD_TYPES } from '../../shared/types.ts';
import type { ChoiceColor, Field, FieldOptions, FieldType, RollupFn, SelectChoice } from '../../shared/types.ts';
import { checkFormula } from '../../shared/formula.ts';
import { del, patch, post, put } from '../lib/api.ts';
import { loadTable, toast, invalidateTable } from '../lib/store.ts';
import type { TableDetail } from '../lib/store.ts';
import { Chip, Modal, confirmDialog } from './common.tsx';
import { FIELD_ICON, Icon } from './icons.tsx';

const COLORS: ChoiceColor[] = ['blue', 'green', 'amber', 'red', 'sky', 'gray', 'ink'];
const ROLLUPS: { v: RollupFn; l: string }[] = [{ v: 'count', l: 'Count (non-empty values)' }, { v: 'countAll', l: 'Count linked records' }, { v: 'sum', l: 'Sum' }, { v: 'avg', l: 'Average' }, { v: 'min', l: 'Min' }, { v: 'max', l: 'Max' }, { v: 'join', l: 'Join as text' }, { v: 'unique', l: 'Unique values' }, { v: 'earliest', l: 'Earliest date' }, { v: 'latest', l: 'Latest date' }];
const FUNCS = 'IF, AND, OR, NOT, CONCAT, LEN, UPPER, LOWER, LEFT, RIGHT, MID, FIND, SUBSTITUTE, ROUND, ABS, SQRT, POWER, SUM, AVG, MIN, MAX, COUNT, JOIN, TODAY, NOW, DATEDIFF, DATEADD, SWITCH, GC, REVCOMP, TRANSCRIBE, TRANSLATE, MW, SEQLEN';

export function FieldEditorModal({ tableId, detail, field, onClose, onSaved }: { tableId: string; detail: TableDetail; field?: Field; onClose: () => void; onSaved: (f: Field) => void }) {
  const [name, setName] = useState(field?.name ?? '');
  const [type, setType] = useState<FieldType>(field?.type ?? 'text');
  const [opts, setOpts] = useState<FieldOptions>(field?.options ?? {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [targetFields, setTargetFields] = useState<Field[]>([]);
  const set = (p: Partial<FieldOptions>) => setOpts((o) => ({ ...o, ...p }));
  const isNew = !field;
  const relFields = detail.fields.filter((f) => f.type === 'relation' && f.id !== field?.id);
  const relTarget = type === 'lookup' || type === 'rollup' ? relFields.find((f) => f.id === opts.relationField)?.options.targetTable : undefined;
  useEffect(() => { if (relTarget) loadTable(relTarget).then((d) => setTargetFields(d.fields)); else setTargetFields([]); }, [relTarget]);
  const formulaErr = type === 'formula' && opts.formula ? checkFormula(opts.formula) : null;

  const changeType = (t: FieldType) => {
    setType(t);
    if (t === 'singleSelect' || t === 'multiSelect' || t === 'status') setOpts((o) => ({ choices: o.choices ?? [] }));
    else if (t === 'number') setOpts({ precision: 0 }); else if (t === 'sequence') setOpts({ seqType: 'dna' }); else setOpts({});
  };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body: Record<string, unknown> = { name: name.trim(), options: opts };
      if (isNew || type !== field!.type) body.type = type;
      const r = isNew ? await post(`/api/tables/${tableId}/fields`, body) : await patch(`/api/fields/${field!.id}`, body);
      invalidateTable(tableId);
      if (r.lost) toast(`${r.lost} value(s) could not be converted and were cleared.`, 'info');
      onSaved(r.field); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!await confirmDialog(`Delete the field “${field!.name}”? Its data is removed from every record${field!.type === 'relation' ? ' and the linked field in the other table is deleted too' : ''}. This cannot be undone.`, 'Delete field')) return;
    try { await del(`/api/fields/${field!.id}`); invalidateTable(); onClose(); onSaved(field!); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <Modal title={isNew ? 'Add field' : `Edit field · ${field!.name}`} onClose={onClose}
      footer={<>{!isNew && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={remove}><Icon name="trash" /> Delete</button>}<button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !name.trim() || !!formulaErr} onClick={save}>{busy ? 'Saving…' : 'Save field'}</button></>}>
      <div className="col" style={{ gap: 14 }}>
        {err && <div className="notice err">{err}</div>}
        <label className="field">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></label>
        <label className="field">Type
          <select aria-label="Field type" className="select" value={type} onChange={(e) => changeType(e.target.value as FieldType)} disabled={!isNew && !['text', 'longtext', 'url', 'sequence', 'number', 'singleSelect', 'multiSelect', 'status', 'checkbox', 'date'].includes(field!.type)}>
            {FIELD_TYPES.filter((t) => isNew || t.type === field!.type || ['text', 'longtext', 'url', 'sequence', 'number', 'singleSelect', 'multiSelect', 'status', 'checkbox', 'date'].includes(t.type)).map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
        </label>
        {!isNew && type !== field!.type && <div className="notice warn">Changing the type converts stored values where possible; values that cannot be converted are cleared.</div>}

        {(type === 'singleSelect' || type === 'multiSelect' || type === 'status') && (
          <div className="col" style={{ gap: 6 }}>
            <b className="small">Options</b>
            {(opts.choices ?? []).map((c, i) => (
              <div key={c.id ?? i} className="row">
                <select className="select" style={{ width: 96 }} value={c.color ?? 'gray'} onChange={(e) => set({ choices: opts.choices!.map((x, j) => (j === i ? { ...x, color: e.target.value as ChoiceColor } : x)) })} aria-label="Colour">{COLORS.map((k) => <option key={k}>{k}</option>)}</select>
                <input className="input" value={c.name} onChange={(e) => set({ choices: opts.choices!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} aria-label="Option name" />
                <Chip color={c.color}>{c.name || '…'}</Chip>
                <button className="btn ghost icon sm" onClick={() => set({ choices: opts.choices!.filter((_, j) => j !== i) })} aria-label="Remove option"><Icon name="x" /></button>
              </div>
            ))}
            <button className="btn secondary sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ choices: [...(opts.choices ?? []), { id: '', name: '', color: COLORS[(opts.choices?.length ?? 0) % COLORS.length] } as SelectChoice] })}><Icon name="plus" /> Add option</button>
          </div>
        )}
        {type === 'number' && <label className="field">Decimal places<select className="select" value={opts.precision ?? 0} onChange={(e) => set({ precision: Number(e.target.value) })}>{[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n}>{n}</option>)}</select></label>}
        {type === 'date' && <label className="check"><input type="checkbox" checked={!!opts.includeTime} onChange={(e) => set({ includeTime: e.target.checked })} /> Include time</label>}
        {type === 'sequence' && <label className="field">Sequence type<select className="select" value={opts.seqType ?? 'dna'} onChange={(e) => set({ seqType: e.target.value as 'dna' | 'rna' | 'protein' })}><option value="dna">DNA</option><option value="rna">RNA</option><option value="protein">Protein</option></select></label>}
        {type === 'formula' && (
          <div className="col" style={{ gap: 6 }}>
            <label className="field">Formula<textarea className={`textarea mono${formulaErr ? ' invalid' : ''}`} rows={3} value={opts.formula ?? ''} onChange={(e) => set({ formula: e.target.value })} placeholder='e.g. IF({Length (bp)} > 1000, "long", "short")' spellCheck={false} /></label>
            {formulaErr ? <span className="small" style={{ color: 'var(--red)' }}>{formulaErr}</span> : opts.formula ? <span className="small" style={{ color: 'var(--green)' }}>Syntax OK</span> : null}
            <div className="row wrap">{detail.fields.filter((f) => f.id !== field?.id).map((f) => <button key={f.id} className="chip sky link" style={{ border: 0 }} onClick={() => set({ formula: `${opts.formula ?? ''}{${f.name}}` })}>{f.name}</button>)}</div>
            <span className="muted small">Functions: {FUNCS}. Reference fields as {'{Field name}'}.</span>
          </div>
        )}
        {type === 'relation' && isNew && (
          <label className="field">Link to table
            <select className="select" value={opts.targetTable ?? ''} onChange={(e) => set({ targetTable: e.target.value })}><option value="" disabled>Choose a table…</option>{detail.linkedTables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            <span className="muted small">A matching link field is created in the other table, so the relationship can be followed from both sides.</span>
          </label>
        )}
        {type === 'relation' && !isNew && <div className="muted small">Linked table: {detail.linkedTables.find((t) => t.id === opts.targetTable)?.name ?? opts.targetTable}</div>}
        {(type === 'lookup' || type === 'rollup') && (
          <>
            <label className="field">Through link field<select className="select" value={opts.relationField ?? ''} onChange={(e) => set({ relationField: e.target.value, lookupField: undefined })}><option value="" disabled>Choose…</option>{relFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
            <label className="field">Field in the linked table<select className="select" value={opts.lookupField ?? ''} onChange={(e) => set({ lookupField: e.target.value })} disabled={!targetFields.length}><option value="" disabled>Choose…</option>{targetFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
            {type === 'rollup' && <label className="field">Summarise with<select className="select" value={opts.rollupFn ?? 'count'} onChange={(e) => set({ rollupFn: e.target.value as RollupFn })}>{ROLLUPS.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}</select></label>}
          </>
        )}
      </div>
    </Modal>
  );
}

/** All fields of a table: show/hide in the current view, reorder (the first is the primary field), edit, delete. */
export function FieldsManager({ tableId, detail, hidden, onToggle, onClose, onChanged, onEdit, onAdd }: { tableId: string; detail: TableDetail; hidden: string[]; onToggle: (id: string) => void; onClose: () => void; onChanged: () => void; onEdit: (f: Field) => void; onAdd: () => void }) {
  const move = async (i: number, d: number) => {
    const ids = detail.fields.map((f) => f.id); const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await put(`/api/tables/${tableId}/fields/order`, { order: ids }); invalidateTable(tableId); onChanged(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <Modal title="Fields" onClose={onClose} footer={<><button className="btn secondary" onClick={onAdd}><Icon name="plus" /> Add field</button><button className="btn" onClick={onClose}>Done</button></>}>
      <div className="col" style={{ gap: 2 }}>
        {detail.fields.map((f, i) => (
          <div key={f.id} className="row" style={{ padding: '4px 2px', borderBottom: '1px solid var(--line)' }}>
            <button className="btn ghost icon sm" onClick={() => onToggle(f.id)} aria-label={hidden.includes(f.id) ? `Show ${f.name}` : `Hide ${f.name}`} disabled={i === 0} title={i === 0 ? 'The primary field is always shown' : undefined}><Icon name={hidden.includes(f.id) ? 'eyeoff' : 'eye'} /></button>
            <span className="muted"><Icon name={FIELD_ICON[f.type] ?? 'text'} /></span>
            <span className="grow">{f.name} {i === 0 && <span className="badge">primary</span>} <span className="muted small">{FIELD_TYPES.find((t) => t.type === f.type)?.label}</span></span>
            <button className="btn ghost icon sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon name="chevU" /></button>
            <button className="btn ghost icon sm" disabled={i === detail.fields.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><Icon name="chevD" /></button>
            <button className="btn ghost sm" onClick={() => onEdit(f)}>Edit</button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
