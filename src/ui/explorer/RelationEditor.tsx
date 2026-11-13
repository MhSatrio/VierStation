// Structured relationship editor: “(This record) is related to (record) as (type)” with evidence, description, citations and tags.
// The drag-and-drop connector in the graph and the “+ Add relation” section of a record both use this component and the same POST /api/relationships,
// so both ways produce identical records. Nothing is saved until the researcher presses Save.
import { useEffect, useMemo, useRef, useState } from 'react';
import { EVIDENCE, CITATION_KINDS, GRAPH_KINDS, citationUrl } from '../../../shared/graph.ts';
import { get, post } from '../../lib/api.ts';
import { toast, useSession } from '../../lib/store.ts';
import { Chip, Spinner, confirmDialog, useDebounced } from '../common.tsx';
import { Hint, HelpTip } from '../Tip.tsx';
import { Icon } from '../icons.tsx';
import { ShapeGlyph } from './style.tsx';

export interface RelType { id: string; name: string; inverseName: string | null; description: string; directional: boolean; sourceKinds: string[]; targetKinds: string[]; edgeStyle: string; builtin: boolean; uses?: number }
export interface Pick { id: string; name: string; kind: string; accession?: string | null }
export interface CiteRow { kind: string; value: string; title?: string }

export const KIND_LABEL: Record<string, string> = { dna: 'DNA', rna: 'RNA', gene: 'Gene', protein: 'Protein', chemical: 'Chemical', reaction: 'Reaction', pathway: 'Pathway', organism: 'Organism', publication: 'Publication', structure: 'Structure' };
export const glyphOf = (kind: string) => (kind === 'chemical' || kind === 'protein' || kind === 'gene' ? kind : kind);

/** relationship types of the current workspace (built-in + custom), reloaded when the list changes */
export function useRelTypes() {
  const wsId = useSession((s) => s.wsId);
  const [types, setTypes] = useState<RelType[]>([]);
  const load = () => { if (wsId) get(`/api/explorer/types?workspace=${wsId}`).then((r) => setTypes(r.types), () => {}); };
  useEffect(load, [wsId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { types, reload: load };
}

/** Search the workspace's records by name or accession; offers “create new” (find-or-create, so “Glucose” is never duplicated). */
export function TargetPicker({ value, onChange, kinds, exclude, placeholder = 'Search a record by name or accession…', allowCreate = true, label }: { value: Pick | null; onChange: (p: Pick | null) => void; kinds?: string[]; exclude?: string; placeholder?: string; allowCreate?: boolean; label: string }) {
  const wsId = useSession((s) => s.wsId), projectId = useSession((s) => s.projectId);
  const [text, setText] = useState(''); const term = useDebounced(text.trim(), 250);
  const [res, setRes] = useState<Pick[]>([]); const [busy, setBusy] = useState(false); const [open, setOpen] = useState(false);
  const [newKind, setNewKind] = useState(kinds?.[0] ?? 'chemical');
  const seq = useRef(0);
  useEffect(() => {
    if (!wsId || term.length < 1) { setRes([]); return; }
    const n = ++seq.current;
    get(`/api/explorer/search?workspace=${wsId}&q=${encodeURIComponent(term)}${kinds ? `&kinds=${kinds.join(',')}` : ''}`).then((r) => { if (n === seq.current) setRes((r.results as Pick[]).filter((x) => x.id !== exclude)); }, () => {});
  }, [term, wsId, kinds?.join(','), exclude]); // eslint-disable-line react-hooks/exhaustive-deps
  if (value) return <span className="pickchip"><ShapeGlyph type={glyphOf(value.kind)} size={16} /><b>{value.name}</b><span className="muted small">{KIND_LABEL[value.kind] ?? value.kind}</span><button type="button" className="btn ghost icon sm" onClick={() => onChange(null)} aria-label={`Change ${label}`}><Icon name="x" size={12} /></button></span>;
  const exact = res.some((r) => r.name.toLowerCase() === text.trim().toLowerCase());
  const create = async () => {
    if (!projectId) return; setBusy(true);
    try { const r = await post('/api/explorer/quick-record', { projectId, kind: newKind, name: text.trim() }); onChange({ id: r.id, name: text.trim(), kind: newKind }); toast(r.created ? `Created ${KIND_LABEL[newKind]?.toLowerCase()} “${text.trim()}”` : `Using the existing record “${text.trim()}”`, 'ok'); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="picker" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <input className="input" value={text} placeholder={placeholder} aria-label={label} role="combobox" aria-expanded={open && !!text} onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setOpen(true); }} />
      {open && text.trim() && (
        <div className="picklist" role="listbox">
          {res.slice(0, 8).map((r) => <button key={r.id} type="button" role="option" aria-selected="false" className="pickrow" onClick={() => { onChange(r); setText(''); }}><ShapeGlyph type={glyphOf(r.kind)} size={16} /><span>{r.name}</span><span className="muted small">{KIND_LABEL[r.kind] ?? r.kind}{r.accession ? ` · ${r.accession}` : ''}</span></button>)}
          {!res.length && <div className="muted small" style={{ padding: '6px 10px' }}>No record with that name.</div>}
          {allowCreate && !exact && (
            <div className="pickrow create">
              <span className="small">Create “{text.trim()}” as</span>
              <select className="select" style={{ width: 'auto', minHeight: 26, padding: '0 6px' }} value={newKind} onChange={(e) => setNewKind(e.target.value)} aria-label="Kind of the new record">{(kinds ?? [...GRAPH_KINDS]).map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}</select>
              <button type="button" className="btn sm" disabled={busy} onClick={() => void create()}>{busy ? <Spinner /> : <Icon name="plus" />} Create</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CitationsEditor({ rows, onChange }: { rows: CiteRow[]; onChange: (r: CiteRow[]) => void }) {
  const set = (i: number, p: Partial<CiteRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="col" style={{ gap: 4 }}>
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ gap: 6, alignItems: 'center' }}>
          <select className="select" style={{ width: 128 }} value={r.kind} onChange={(e) => set(i, { kind: e.target.value, value: '' })} aria-label="Citation type">{CITATION_KINDS.map((k) => <option key={k} value={k}>{k === 'record' ? 'VierStation publication' : k.toUpperCase() === 'DOI' || k === 'pmid' || k === 'url' ? k.toUpperCase() : k === 'uniprot' ? 'UniProt' : k === 'pubchem' ? 'PubChem' : 'Accession'}</option>)}</select>
          {r.kind === 'record'
            ? <div style={{ flex: 1 }}><TargetPicker value={r.value ? { id: r.value, name: r.title ?? r.value, kind: 'publication' } : null} onChange={(p) => set(i, { value: p?.id ?? '', title: p?.name })} kinds={['publication']} label="Publication record" placeholder="Search a publication record…" /></div>
            : <input className="input" style={{ flex: 1 }} value={r.value} onChange={(e) => set(i, { value: e.target.value })} placeholder={r.kind === 'doi' ? '10.1000/xyz123' : r.kind === 'pmid' ? '12345678' : r.kind === 'url' ? 'https://…' : r.kind === 'uniprot' ? 'P12345' : r.kind === 'pubchem' ? 'CID 2244' : 'Accession'} aria-label="Citation value" />}
          {r.kind !== 'record' && citationUrl(r.kind, r.value) && r.value && <a className="btn ghost icon sm" href={citationUrl(r.kind, r.value)!} target="_blank" rel="noreferrer noopener" aria-label="Open source in a new tab" title="Open source"><Icon name="link" size={13} /></a>}
          <button type="button" className="btn ghost icon sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove citation"><Icon name="x" size={13} /></button>
        </div>
      ))}
      <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...rows, { kind: 'doi', value: '' }])}><Icon name="plus" /> Add citation</button>
    </div>
  );
}

export const splitTags = (s: string) => [...new Set(s.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean))];

interface Row { key: number; target: Pick | null; typeName: string; reverse: boolean; evidence: string; description: string; organism: string; cites: CiteRow[]; tags: string; more: boolean; status: 'idle' | 'saving' | 'saved' | 'error'; error?: string; savedId?: string }
let rowKey = 1;
const blank = (typeName = '', target: Pick | null = null): Row => ({ key: rowKey++, target, typeName, reverse: false, evidence: 'user_supplied', description: '', organism: '', cites: [], tags: '', more: false, status: 'idle' });

export function RelationEditor({ source, fixedTarget, initialType, onSaved, onCancel, saveLabel }: { source: Pick; fixedTarget?: Pick; initialType?: string; onSaved: () => void; onCancel?: () => void; saveLabel?: string }) {
  const { types, reload } = useRelTypes();
  const [rows, setRows] = useState<Row[]>(() => [blank(initialType ?? '', fixedTarget ?? null)]);
  const set = (key: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const typeOf = (name: string) => types.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
  const list = useMemo(() => types.map((t) => t.name), [types]);

  const saveRow = async (r: Row, allow = false): Promise<boolean> => {
    if (!r.target) { set(r.key, { status: 'error', error: 'Choose the record to relate to.' }); return false; }
    if (!r.typeName.trim()) { set(r.key, { status: 'error', error: 'Choose a relationship type, or type a new one.' }); return false; }
    set(r.key, { status: 'saving', error: undefined });
    const a = r.reverse ? r.target : source, b = r.reverse ? source : r.target;
    try {
      const res = await post('/api/relationships', { sourceId: a.id, targetId: b.id, typeName: r.typeName.trim(), evidenceClass: r.evidence, description: r.description, organism: r.organism || undefined, citations: r.cites.filter((c) => c.value.trim()).map((c) => ({ kind: c.kind, value: c.value.trim(), title: c.title })), tags: splitTags(r.tags), allowIncompatible: allow || undefined });
      set(r.key, { status: 'saved', savedId: res.relationship.id }); if (!typeOf(r.typeName)) reload(); return true;
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'incompatible' && !allow && await confirmDialog(`${err.message.replace(/ Create it anyway only if you are sure\.$/, '')}\n\nSave it anyway?`, 'Save anyway', false)) return saveRow(r, true);
      set(r.key, { status: 'error', error: err.message }); return false;
    }
  };
  const saveAll = async () => { let ok = 0; for (const r of rows.filter((x) => x.status !== 'saved')) if (await saveRow(r)) ok++; if (ok) { toast(`${ok} relationship${ok > 1 ? 's' : ''} saved`, 'ok'); onSaved(); } };
  const saveOne = async (r: Row) => { if (await saveRow(r)) { toast('Relationship saved', 'ok'); onSaved(); } };
  const pending = rows.filter((r) => r.status !== 'saved');

  return (
    <div className="col" style={{ gap: 12 }}>
      <datalist id="relTypeList">{list.map((n) => <option key={n} value={n} />)}</datalist>
      {rows.map((r) => {
        const t = typeOf(r.typeName); const ev = EVIDENCE.find((x) => x.id === r.evidence);
        const a = r.reverse ? r.target : source, b = r.reverse ? source : r.target;
        return (
          <fieldset key={r.key} className={`relrow ${r.status}`} disabled={r.status === 'saved' || r.status === 'saving'}>
            <div className="relsent">
              <span className="pickchip"><ShapeGlyph type={glyphOf(source.kind)} size={16} /><b>{source.name}</b></span>
              <span>{r.reverse ? 'is the' : 'is'} related to</span>
              {fixedTarget && r.target ? <span className="pickchip"><ShapeGlyph type={glyphOf(r.target.kind)} size={16} /><b>{r.target.name}</b></span> : <div style={{ minWidth: 220, flex: '1 1 220px' }}><TargetPicker value={r.target} onChange={(p) => set(r.key, { target: p, status: 'idle', error: undefined })} exclude={source.id} label="Related record" /></div>}
              <span>as</span>
              <input className="input" style={{ width: 190 }} list="relTypeList" value={r.typeName} onChange={(e) => set(r.key, { typeName: e.target.value, status: 'idle' })} placeholder="Relationship type" aria-label="Relationship type" />
              <HelpTip text={t ? `${t.name}: ${t.description} ${t.directional ? 'Directional: the first record acts on the second.' : 'Not directional.'}` : 'Pick a type from the list, or type a new name to create a custom relationship type for this workspace.'} label="relationship type" />
            </div>
            {t && <div className="small muted">{t.description}{t.directional && a && b ? <> · <b>{a.name}</b> → <b>{b.name}</b></> : ''}</div>}
            {t?.directional && r.target && <label className="check small"><input type="checkbox" checked={r.reverse} onChange={(e) => set(r.key, { reverse: e.target.checked })} /><span>Reverse the direction (the other record acts on “{source.name}”)</span></label>}
            <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
              <label className="fld" style={{ minWidth: 210 }}><span className="small">Evidence <HelpTip text={ev?.help} label="evidence class" /></span>
                <select className="select" value={r.evidence} onChange={(e) => set(r.key, { evidence: e.target.value })} aria-label="Evidence class">{EVIDENCE.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
              <label className="fld" style={{ flex: 1, minWidth: 220 }}><span className="small">Description</span><input className="input" value={r.description} onChange={(e) => set(r.key, { description: e.target.value })} placeholder="What the relationship means, in one sentence" aria-label="Description" /></label>
            </div>
            <div className="fld"><span className="small">Citations (DOI, PMID, accession, UniProt, PubChem, URL or a VierStation publication record) <HelpTip text="A citation says where the statement comes from. Without one, choose “User supplied” or “Unverified” rather than a stronger evidence class." label="citations" /></span><CitationsEditor rows={r.cites} onChange={(c) => set(r.key, { cites: c })} /></div>
            <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
              <label className="fld" style={{ flex: 1, minWidth: 200 }}><span className="small">Tags (comma separated) <HelpTip text="Tags are filters you define (for example “Glycolysis”). They group relationships for searching and never imply cause or order." label="tags" /></span><input className="input" value={r.tags} onChange={(e) => set(r.key, { tags: e.target.value })} placeholder="e.g. Glycolysis, Glucose metabolism" aria-label="Tags" /></label>
              <label className="fld" style={{ width: 200 }}><span className="small">Organism (optional)</span><input className="input" value={r.organism} onChange={(e) => set(r.key, { organism: e.target.value })} aria-label="Organism" /></label>
            </div>
            {r.status === 'error' && <div className="notice err" role="alert">{r.error}</div>}
            {r.status === 'saved' && <div className="notice ok" role="status"><Icon name="check" size={13} /> Saved. <span className="muted small">Both records are unchanged; edit or delete the relationship from the record or the graph.</span></div>}
            {r.status !== 'saved' && <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
              {rows.length > 1 && <button type="button" className="btn ghost sm" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>Remove</button>}
              <button type="button" className="btn secondary sm" onClick={() => void saveOne(r)}>{r.status === 'saving' ? <Spinner /> : null} Save this relationship</button>
            </div>}
          </fieldset>
        );
      })}
      <div className="row between wrap">
        {!fixedTarget ? <button type="button" className="btn ghost sm" onClick={() => setRows((rs) => [...rs, blank()])}><Icon name="plus" /> Add another relationship</button> : <span />}
        <div className="row" style={{ gap: 6 }}>
          {onCancel && <button type="button" className="btn secondary" onClick={onCancel}>{pending.length < rows.length ? 'Done' : 'Cancel'}</button>}
          {(pending.length > 1 || (fixedTarget && pending.length > 0)) && <button type="button" className="btn" onClick={() => void saveAll()}>{saveLabel ?? (pending.length > 1 ? `Save all (${pending.length})` : 'Save relationship')}</button>}
        </div>
      </div>
      <Hint text="Saving never changes the two records themselves – it only adds a relationship between them."><span className="muted small">A relationship is only created when you press a Save button.</span></Hint>
    </div>
  );
}
