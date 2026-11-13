// Inspector panel: everything about the selected node (record) or edge (relationship) without leaving the graph.
// It shows WHERE each piece of information comes from (external database / imported / generated / manual) and never presents a database entry as an experiment.
import { useCallback, useEffect, useState } from 'react';
import { EVIDENCE, VERIFICATION, citationUrl, nodeTypeOf, normalizeEvidence } from '../../../shared/graph.ts';
import { del, get, patch, post, put } from '../../lib/api.ts';
import { toast, useEvent } from '../../lib/store.ts';
import { navigate } from '../../lib/router.tsx';
import { Chip, Modal, Spinner, ago, confirmDialog, copyText, fmtDate } from '../common.tsx';
import { HelpTip } from '../Tip.tsx';
import { Icon } from '../icons.tsx';
import { CitationsEditor, KIND_LABEL, RelationEditor, splitTags, useRelTypes } from './RelationEditor.tsx';
import type { CiteRow } from './RelationEditor.tsx';
import { LineGlyph, ShapeGlyph, typeInfo } from './style.tsx';
import { Thumb } from './Thumb.tsx';
import { PathwayEditor, ReactionEditor } from './Editors.tsx';

export const EvBadge = ({ ev }: { ev: string }) => { const e = EVIDENCE.find((x) => x.id === normalizeEvidence(ev)); return <span className="evbadge" title={e?.help}><LineGlyph ev={normalizeEvidence(ev)} />{e?.label ?? ev}</span>; };

const EXTERNAL_LINKS: Record<string, (v: string) => string | null> = {
  accession: (v) => (/^[A-NR-Z][0-9][A-Z0-9]{3}[0-9]$|^[OPQ][0-9][A-Z0-9]{3}[0-9]$/.test(v.replace(/-\d+$/, '')) ? `https://www.uniprot.org/uniprotkb/${encodeURIComponent(v.replace(/-\d+$/, ''))}` : /^[1-9][A-Za-z0-9]{3}$/.test(v) ? `https://www.rcsb.org/structure/${v.toUpperCase()}` : /^(NC|NM|NR|XM|XR|NG|NW|AC|NZ|[A-Z]{1,2}\d{5,6})/.test(v) ? `https://www.ncbi.nlm.nih.gov/nuccore/${encodeURIComponent(v)}` : null),
  geneId: (v) => (/^\d+$/.test(v) ? `https://www.ncbi.nlm.nih.gov/gene/${v}` : null),
  cid: (v) => (/^\d+$/.test(v.replace(/^CID\s*/i, '')) ? `https://pubchem.ncbi.nlm.nih.gov/compound/${v.replace(/^CID\s*/i, '')}` : null),
  inchikey: (v) => (/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/.test(v) ? `https://pubchem.ncbi.nlm.nih.gov/#query=${v}` : null),
  doi: (v) => `https://doi.org/${v}`, pmid: (v) => `https://pubmed.ncbi.nlm.nih.gov/${v}/`,
};
const FIELD_ORDER = ['name', 'accession', 'geneId', 'cid', 'organism', 'formula', 'mw', 'inchikey', 'smiles', 'function', 'family', 'domains', 'equation', 'reversible', 'ec', 'compartment', 'conditions', 'evidence', 'source', 'description', 'sequence'];

interface Loaded { record: { id: string; fields: Record<string, unknown>; updatedAt: string }; table: { id: string; name: string; kind: string; level: string }; fields: { id: string; key?: string; name: string; type: string; options: any }[]; provenance: { id: string; sourceDb: string; step: string; accession?: string; query?: string; url?: string; note?: string; retrievedAt: string }[] }

function provenanceClass(p: Loaded['provenance']): { label: string; color: string; detail: string } {
  if (!p.length) return { label: 'Manual entry', color: 'gray', detail: 'Entered by a researcher; no external source is recorded.' };
  const gen = p.find((x) => /vierstation|merge|consensus|analysis|alignment|cleaning/i.test(`${x.sourceDb} ${x.step}`));
  if (gen && p.every((x) => /vierstation|merge|consensus|analysis|alignment|cleaning|import/i.test(`${x.sourceDb} ${x.step}`))) return { label: 'VierStation-generated', color: 'blue', detail: `${gen.sourceDb} · ${gen.step}` };
  const ext = [...new Set(p.map((x) => x.sourceDb))].join(', ');
  return { label: 'External database / imported', color: 'sky', detail: `${ext} · last retrieved ${fmtDate(p[p.length - 1].retrievedAt, true)}` };
}

export function NodeInspector({ id, more, onClose, onExpand, onExplore, onSelectEdge, onOpenOther, onChanged, onShowPathway }: { id: string; more: number; onClose: () => void; onExpand: () => void; onExplore: () => void; onSelectEdge: (edgeId: string) => void; onOpenOther: (id: string) => void; onChanged: () => void; onShowPathway: (id: string) => void }) {
  const [d, setD] = useState<Loaded | null>(null); const [err, setErr] = useState('');
  const [rels, setRels] = useState<any[] | null>(null); const [paths, setPaths] = useState<any[]>([]); const [tags, setTags] = useState<string[]>([]); const [cites, setCites] = useState<CiteRow[] | null>(null); const [reaction, setReaction] = useState<any>(null);
  const [adding, setAdding] = useState(false); const [editR, setEditR] = useState(false); const [editP, setEditP] = useState(false);
  const [tagText, setTagText] = useState('');
  const load = useCallback(() => {
    get<Loaded>(`/api/records/${id}`).then((r) => { setD(r); setErr(''); }, (e) => setErr(e.message));
    get(`/api/records/${id}/relationships`).then((r) => setRels(r.relationships), () => setRels([]));
    get(`/api/records/${id}/pathways`).then((r) => setPaths(r.pathways), () => setPaths([]));
    get(`/api/records/${id}/tags`).then((r) => { setTags(r.tags); setTagText(r.tags.join(', ')); }, () => {});
    get(`/api/records/${id}/citations`).then((r) => setCites(r.citations.map((c: any) => ({ kind: c.kind, value: c.value, title: c.title }))), () => setCites([]));
  }, [id]);
  useEffect(() => { setD(null); setRels(null); setReaction(null); load(); }, [load]);
  useEffect(() => { if (d?.table.kind === 'reaction') get(`/api/reactions/${id}`).then(setReaction, () => {}); else setReaction(null); }, [d?.table.kind, id, rels]);
  useEvent('graph.changed', load, [id]); useEvent('record.changed', load, [id]);

  if (err) return <aside className="insp"><header><b>Record</b><button className="btn ghost icon sm" onClick={onClose} aria-label="Close inspector"><Icon name="x" /></button></header><div className="empty"><b>Cannot open this record</b>{err}</div></aside>;
  if (!d) return <aside className="insp"><header><Spinner /></header></aside>;
  const kind = d.table.kind; const canEdit = d.table.level === 'editor' || d.table.level === 'admin';
  const f = (k: string) => d.fields.find((x) => x.key === k); const val = (k: string) => { const fd = f(k); return fd ? d.record.fields[fd.id] : undefined; };
  const name = String(val('name') ?? '(unnamed)');
  const subtype = ['protType', 'chemType'].map((k) => { const fd = f(k); const c = fd?.options?.choices?.find((x: any) => x.id === d.record.fields[fd.id]); return c?.name; }).find(Boolean) ?? null;
  const type = nodeTypeOf(kind, subtype);
  const prov = provenanceClass(d.provenance);
  const shown = [...d.fields].filter((x) => x.type !== 'relation' && x.type !== 'thumbnail' && x.type !== 'attachment' && x.type !== 'formula' && x.type !== 'lookup' && x.type !== 'rollup' && x.type !== 'createdTime' && x.type !== 'lastModifiedTime' && x.key !== 'name' && !(kind === 'reaction' && x.key === 'equation')).sort((a, b) => { const ia = FIELD_ORDER.indexOf(a.key ?? ''), ib = FIELD_ORDER.indexOf(b.key ?? ''); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
  const choiceName = (fd: Loaded['fields'][number], v: unknown) => (fd.type === 'singleSelect' || fd.type === 'status' ? fd.options?.choices?.find((c: any) => c.id === v)?.name : fd.type === 'multiSelect' ? (v as string[]).map((x) => fd.options?.choices?.find((c: any) => c.id === x)?.name).filter(Boolean).join(', ') : undefined);
  const saveTags = async () => { try { const r = await put(`/api/records/${id}/tags`, { tags: splitTags(tagText) }); setTags(r.tags); setTagText(r.tags.join(', ')); onChanged(); } catch (e) { toast((e as Error).message, 'err'); } };
  const saveCites = async () => { try { await put(`/api/records/${id}/citations`, { citations: (cites ?? []).filter((c) => c.value.trim()) }); toast('Citations saved', 'ok'); load(); } catch (e) { toast((e as Error).message, 'err'); } };
  const removeRel = async (rid: string) => { if (!(await confirmDialog('Delete this relationship? The two records stay exactly as they are.', 'Delete relationship'))) return; try { await del(`/api/relationships/${rid}`); toast('Relationship deleted – both records kept', 'ok'); onChanged(); load(); } catch (e) { toast((e as Error).message, 'err'); } };
  const seq = typeof val('sequence') === 'string' ? (val('sequence') as string) : '';

  return (
    <aside className="insp" aria-label={`Inspector: ${name}`}>
      <header>
        <ShapeGlyph type={type} size={26} />
        <div className="grow"><h2>{name}</h2><div className="muted small">{typeInfo(type).label}{subtype && subtype.toLowerCase() !== typeInfo(type).label.toLowerCase() ? ` · ${subtype}` : ''} · {d.table.name}</div></div>
        <button className="btn ghost icon sm" onClick={onClose} aria-label="Close inspector"><Icon name="x" /></button>
      </header>
      <div className="body">
        <div className="row wrap" style={{ gap: 6 }}>
          <Chip color={prov.color} title={prov.detail}>{prov.label}</Chip><span className="muted small">{prov.detail}</span>
        </div>
        <div className="row wrap" style={{ gap: 6, margin: '8px 0' }}>
          {more > 0 && <button className="btn secondary sm" onClick={onExpand}><Icon name="plus" /> Show {more} more connection{more > 1 ? 's' : ''}</button>}
          <button className="btn secondary sm" onClick={onExplore}><Icon name="graph" /> Explore related network</button>
          <button className="btn ghost sm" onClick={() => onOpenOther(id)}><Icon name="grid" /> Open record</button>
        </div>

        {['chemical', 'protein', 'structure'].includes(kind) && <section><h3>Structure image</h3><div className="row" style={{ gap: 12, alignItems: 'center' }}><Thumb id={id} size={92} name={name} /><span className="muted small">Fetched from a database identifier, stored on this computer. Click for the source, whether it is experimental or predicted, and a refresh button.</span></div></section>}

        <section>
          <h3>Details</h3>
          <dl className="kv">
            {shown.map((fd) => {
              const v = d.record.fields[fd.id]; if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return null;
              const text = choiceName(fd, v) ?? (fd.type === 'structure' ? `${(v as any).id}${(v as any).predicted ? ' (predicted)' : ' (experimental)'}` : fd.type === 'checkbox' ? (v ? 'Yes' : 'No') : String(v));
              const link = fd.key ? EXTERNAL_LINKS[fd.key]?.(String(v)) : null;
              return <div key={fd.id} style={{ display: 'contents' }}><dt>{fd.name}</dt><dd>{fd.key === 'sequence' ? <span className="seq" style={{ wordBreak: 'break-all' }}>{text.slice(0, 120)}{text.length > 120 ? `… ${text.length.toLocaleString()} ${fd.options?.seqType === 'protein' ? 'aa' : 'bp'}` : ''} <button className="btn ghost sm" onClick={() => void copyText(text).then((ok) => toast(ok ? 'Sequence copied' : 'Could not copy', ok ? 'ok' : 'err'))}>Copy</button></span> : link ? <a href={link} target="_blank" rel="noreferrer noopener">{text} ↗</a> : <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>}</dd></div>;
            })}
          </dl>
          {seq && <div className="muted small">Full sequence: open the record{kind === 'dna' || kind === 'rna' ? ' or the Sequence Lab' : ''}.</div>}
        </section>

        {reaction && (
          <section>
            <h3>Reaction</h3>
            <div className="eqbox"><b>{reaction.equation || 'No participants yet'}</b><span className="muted small">{reaction.reversible ?? 'Reversibility unknown'}{reaction.organism ? ` · ${reaction.organism}` : ''}{reaction.compartment ? ` · ${reaction.compartment}` : ''}</span></div>
            <table className="mini"><tbody>{reaction.participants.map((p: any) => <tr key={p.id}><td><Chip color="sky">{p.role}</Chip></td><td><button className="btn ghost sm" style={{ padding: '0 4px' }} onClick={() => onOpenOther(p.recordId)}>{p.name}</button></td><td className="muted small">{p.stoichiometry && p.stoichiometry !== 1 ? `× ${p.stoichiometry}` : ''}</td></tr>)}</tbody></table>
            {canEdit && <button className="btn secondary sm" onClick={() => setEditR(true)}><Icon name="edit" /> Edit participants</button>}
          </section>
        )}
        {kind === 'pathway' && <section><h3>Pathway</h3><div className="row wrap" style={{ gap: 6 }}><button className="btn secondary sm" onClick={() => onShowPathway(id)}><Icon name="pathway" /> Show as pathway</button>{canEdit && <button className="btn secondary sm" onClick={() => setEditP(true)}><Icon name="edit" /> Edit steps and order</button>}</div></section>}

        <section>
          <h3>Relationships {rels ? `(${rels.length})` : ''} <HelpTip text="Stored relationships of this record. Each one has its own type, evidence, citations and tags. Select one to see and edit it." label="relationships" /></h3>
          {!rels ? <Spinner /> : !rels.length ? <div className="muted small">No stored relationships yet.</div> : (
            <div className="col" style={{ gap: 4 }}>{rels.map((r) => {
              const out = r.sourceId === id; const other = out ? { id: r.targetId, name: r.targetName, kind: r.targetKind } : { id: r.sourceId, name: r.sourceName, kind: r.sourceKind };
              return (
                <div key={r.id} className="relitem">
                  <button className="relmain" onClick={() => onSelectEdge(r.id)} title="Show this relationship in the graph"><ShapeGlyph type={other.kind} size={15} /><span><b>{out ? r.type.name : r.type.inverseName ?? `${r.type.name} (incoming)`}</b>{r.directional ? (out ? ' → ' : ' ← ') : ' – '}<span>{other.name}</span></span></button>
                  <EvBadge ev={r.evidenceClass} />
                  {r.citations.length > 0 && <span className="muted small" title="Citations">📎{r.citations.length}</span>}
                  {canEdit && <button className="btn ghost icon sm" onClick={() => void removeRel(r.id)} aria-label="Delete relationship"><Icon name="trash" size={13} /></button>}
                </div>
              );
            })}</div>
          )}
          {canEdit && <button className="btn secondary sm" style={{ marginTop: 6 }} onClick={() => setAdding(true)}><Icon name="plus" /> Add relation</button>}
        </section>

        <section>
          <h3>Pathways {paths.length ? `(${paths.length})` : ''}</h3>
          {!paths.length ? <div className="muted small">Not part of any pathway.</div> : <div className="row wrap" style={{ gap: 6 }}>{paths.map((p) => <button key={p.id} className="chip sky link" onClick={() => onShowPathway(p.id)} title={`Show ${p.name} as a pathway`}>{p.name}</button>)}</div>}
        </section>

        <section>
          <h3>Tags <HelpTip text="Tags are filters you define. They group records for searching and never imply causality or order." label="tags" /></h3>
          {canEdit ? <div className="row" style={{ gap: 6 }}><input className="input" value={tagText} onChange={(e) => setTagText(e.target.value)} onBlur={() => { if (splitTags(tagText).join('|') !== tags.join('|')) void saveTags(); }} onKeyDown={(e) => { if (e.key === 'Enter') void saveTags(); }} placeholder="comma separated, e.g. Glycolysis" aria-label="Tags" /></div> : <div className="row wrap">{tags.map((t) => <Chip key={t} color="sky">{t}</Chip>)}</div>}
        </section>

        <section>
          <h3>Citations</h3>
          {cites === null ? <Spinner /> : canEdit ? <div className="col" style={{ gap: 6 }}><CitationsEditor rows={cites} onChange={setCites} /><button className="btn secondary sm" style={{ alignSelf: 'flex-start' }} onClick={() => void saveCites()}>Save citations</button></div> : cites.map((c, i) => <div key={i} className="small">{c.kind.toUpperCase()}: {citationUrl(c.kind, c.value) ? <a href={citationUrl(c.kind, c.value)!} target="_blank" rel="noreferrer noopener">{c.value} ↗</a> : c.value}</div>)}
        </section>

        <section>
          <h3>Source & history</h3>
          {d.provenance.length === 0 ? <div className="muted small">Created by hand in VierStation. Imported records list every source here.</div> : <div className="tl">{[...d.provenance].reverse().map((p) => (
            <div key={p.id}><div className="row wrap" style={{ gap: 6 }}><b>{p.sourceDb}</b><Chip color="gray">{p.step}</Chip><span className="muted small">{fmtDate(p.retrievedAt, true)}</span></div>
              <div className="small">{p.accession && <span className="mono">{p.accession}</span>}{p.url && <> · <a href={p.url} target="_blank" rel="noreferrer noopener">source ↗</a></>}</div>{p.note && <div className="small muted">{p.note}</div>}</div>
          ))}</div>}
          <div className="muted small" style={{ marginTop: 6 }}>Updated {ago(d.record.updatedAt)}</div>
        </section>
      </div>
      {adding && <Modal title={`Add relation to ${name}`} onClose={() => setAdding(false)} size="wide"><RelationEditor source={{ id, name, kind }} onSaved={() => { onChanged(); load(); }} onCancel={() => setAdding(false)} /></Modal>}
      {editR && <ReactionEditor reactionId={id} onClose={() => setEditR(false)} onSaved={() => { onChanged(); load(); }} />}
      {editP && <PathwayEditor pathwayId={id} onClose={() => setEditP(false)} onSaved={() => { onChanged(); load(); }} />}
    </aside>
  );
}

// ---------------------------------------------------------------- edge
export function EdgeInspector({ edge, names, onClose, onChanged, onSelectNode }: { edge: any; names: Record<string, string>; onClose: () => void; onChanged: () => void; onSelectNode: (id: string) => void }) {
  const [rel, setRel] = useState<any>(null); const [err, setErr] = useState(''); const [editing, setEditing] = useState(false);
  const { types } = useRelTypes();
  const [f, setF] = useState<{ typeId: string; evidenceClass: string; description: string; verification: string; organism: string; conditions: string; tags: string; cites: CiteRow[] }>({ typeId: '', evidenceClass: 'user_supplied', description: '', verification: 'unverified', organism: '', conditions: '', tags: '', cites: [] });
  const [editR, setEditR] = useState<string | null>(null);
  const isRel = edge.origin === 'relationship';
  const load = useCallback(() => { if (!isRel) return; get(`/api/relationships/${edge.id}`).then((r) => { setRel(r.relationship); setErr(''); }, (e) => setErr(e.message)); }, [edge.id, isRel]);
  useEffect(() => { setRel(null); setEditing(false); load(); }, [load]);
  const start = () => { setF({ typeId: rel.type.id, evidenceClass: rel.evidenceClass, description: rel.description, verification: rel.verification, organism: rel.organism ?? '', conditions: rel.conditions ?? '', tags: rel.tags.join(', '), cites: rel.citations.map((c: any) => ({ kind: c.kind, value: c.value, title: c.title })) }); setEditing(true); };
  const save = async () => { try { const r = await patch(`/api/relationships/${edge.id}`, { typeId: f.typeId, evidenceClass: f.evidenceClass, description: f.description, verification: f.verification, organism: f.organism || null, conditions: f.conditions || null, tags: splitTags(f.tags), citations: f.cites.filter((c) => c.value.trim()) }); setRel(r.relationship); setEditing(false); toast('Relationship saved', 'ok'); onChanged(); } catch (e) { toast((e as Error).message, 'err'); } };
  const remove = async () => { if (!(await confirmDialog('Delete this relationship? The two records stay exactly as they are.', 'Delete relationship'))) return; try { await del(`/api/relationships/${edge.id}`); toast('Relationship deleted – both records kept', 'ok'); onChanged(); onClose(); } catch (e) { toast((e as Error).message, 'err'); } };
  const convert = async () => { try { await post(`/api/links/${String(edge.id).slice(4)}/convert`, {}); toast('Converted into an editable relationship', 'ok'); onChanged(); onClose(); } catch (e) { toast((e as Error).message, 'err'); } };
  const ends = <div className="relends"><button className="btn ghost sm" onClick={() => onSelectNode(edge.source)}>{names[edge.source] ?? edge.source}</button><span aria-hidden="true">{edge.directional ? '→' : '–'}</span><button className="btn ghost sm" onClick={() => onSelectNode(edge.target)}>{names[edge.target] ?? edge.target}</button></div>;
  return (
    <aside className="insp" aria-label="Relationship inspector">
      <header><div className="grow"><h2>{edge.typeName ?? edge.label}</h2><div className="muted small">{isRel ? 'Stored relationship' : edge.origin === 'field' ? 'Link from a record field (imported / discovered)' : edge.origin === 'participant' ? 'Derived from a reaction’s participants' : edge.origin === 'step' ? 'Pathway membership' : 'Pathway order'}</div></div><button className="btn ghost icon sm" onClick={onClose} aria-label="Close inspector"><Icon name="x" /></button></header>
      <div className="body">
        {ends}
        <div style={{ margin: '6px 0' }}><EvBadge ev={isRel && rel ? rel.evidenceClass : edge.evidence} />{(edge.predicted || (rel && ['computationally_predicted', 'unverified'].includes(rel.evidenceClass))) && <Chip color="amber">not an observation</Chip>}</div>
        {(isRel && rel ? rel.evidenceClass : edge.evidence) === 'database_annotated' && <div className="muted small">“Database annotated” means a database states this. It is not, by itself, an experimental confirmation – check the database’s own source.</div>}
        {err && <div className="notice err">{err}</div>}
        {isRel && !rel && !err && <Spinner />}
        {isRel && rel && !editing && (
          <>
            <dl className="kv">
              <dt>Type</dt><dd>{rel.type.name}{rel.type.inverseName ? <span className="muted"> · reverse: {rel.type.inverseName}</span> : null}</dd>
              <dt>Direction</dt><dd>{rel.directional ? `${rel.sourceName} → ${rel.targetName}` : 'Not directional'}</dd>
              {rel.description && <><dt>Description</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{rel.description}</dd></>}
              {rel.organism && <><dt>Organism</dt><dd>{rel.organism}</dd></>}
              {rel.conditions && <><dt>Conditions</dt><dd>{rel.conditions}</dd></>}
              {rel.sourceDb && <><dt>Source database</dt><dd>{rel.sourceDb}{rel.accession ? ` · ${rel.accession}` : ''}</dd></>}
              <dt>Verification</dt><dd>{VERIFICATION.find((v) => v.id === rel.verification)?.label ?? rel.verification}</dd>
              <dt>Origin</dt><dd>{rel.origin === 'user' ? 'Entered in VierStation (this workspace)' : rel.origin === 'discovery' ? 'Created by discovery from a database record' : rel.origin === 'import' ? 'Imported' : rel.origin}</dd>
              <dt>Created</dt><dd>{fmtDate(rel.createdAt, true)}{rel.updatedAt !== rel.createdAt ? ` · edited ${ago(rel.updatedAt)}` : ''}</dd>
              <dt>Tags</dt><dd>{rel.tags.length ? rel.tags.map((t: string) => <Chip key={t} color="sky">{t}</Chip>) : <span className="muted">none</span>}</dd>
            </dl>
            <h3 style={{ marginTop: 10 }}>Citations ({rel.citations.length})</h3>
            {!rel.citations.length ? <div className="muted small">No citation recorded.</div> : rel.citations.map((c: any, i: number) => <div key={i} className="small">{String(c.kind).toUpperCase()}: {c.url ? <a href={c.url} target="_blank" rel="noreferrer noopener">{c.title || c.value} ↗</a> : c.value}{c.retrievedAt ? <span className="muted"> · retrieved {fmtDate(c.retrievedAt)}</span> : null}</div>)}
            <div className="row" style={{ gap: 6, marginTop: 10 }}><button className="btn secondary sm" onClick={start}><Icon name="edit" /> Edit</button><button className="btn ghost sm" onClick={() => void remove()}><Icon name="trash" /> Delete relationship</button></div>
          </>
        )}
        {isRel && rel && editing && (
          <div className="col" style={{ gap: 8 }}>
            <label className="fld"><span className="small">Type</span><select className="select" value={f.typeId} onChange={(e) => setF({ ...f, typeId: e.target.value })} aria-label="Relationship type">{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <label className="fld"><span className="small">Evidence <HelpTip text={EVIDENCE.find((x) => x.id === f.evidenceClass)?.help} label="evidence" /></span><select className="select" value={f.evidenceClass} onChange={(e) => setF({ ...f, evidenceClass: e.target.value })} aria-label="Evidence class">{EVIDENCE.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
            <label className="fld"><span className="small">Verification</span><select className="select" value={f.verification} onChange={(e) => setF({ ...f, verification: e.target.value })} aria-label="Verification">{VERIFICATION.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
            <label className="fld"><span className="small">Description</span><textarea className="textarea" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} aria-label="Description" /></label>
            <label className="fld"><span className="small">Organism</span><input className="input" value={f.organism} onChange={(e) => setF({ ...f, organism: e.target.value })} aria-label="Organism" /></label>
            <label className="fld"><span className="small">Conditions</span><input className="input" value={f.conditions} onChange={(e) => setF({ ...f, conditions: e.target.value })} aria-label="Conditions" /></label>
            <label className="fld"><span className="small">Tags</span><input className="input" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} aria-label="Tags" /></label>
            <div className="fld"><span className="small">Citations</span><CitationsEditor rows={f.cites} onChange={(c) => setF({ ...f, cites: c })} /></div>
            <div className="row" style={{ gap: 6 }}><button className="btn" onClick={() => void save()}>Save</button><button className="btn secondary" onClick={() => setEditing(false)}>Cancel</button></div>
          </div>
        )}
        {edge.origin === 'field' && (
          <>
            <dl className="kv"><dt>Link name</dt><dd>{edge.label}</dd>{edge.description && <><dt>Evidence note</dt><dd>{edge.description}</dd></>}{edge.sourceDb && <><dt>Source database</dt><dd>{edge.sourceDb}</dd></>}</dl>
            <div className="muted small">This connection comes from a linked-record field. Convert it to add citations, tags and a custom type; the link itself stays.</div>
            <button className="btn secondary sm" style={{ marginTop: 6 }} onClick={() => void convert()}><Icon name="edit" /> Convert into an editable relationship</button>
          </>
        )}
        {edge.origin === 'participant' && <><div className="small">{names[edge.source]} → {names[edge.target]} is drawn because a reaction lists its participants with roles. Role: <b>{edge.role}</b>{edge.label.includes('×') ? ` · ${edge.label.slice(edge.label.indexOf('('))}` : ''}.</div><button className="btn secondary sm" style={{ marginTop: 6 }} onClick={() => setEditR(edge.role === 'reactant' || edge.role === 'inhibitor' || edge.role === 'activator' || edge.role === 'cofactor' || edge.role === 'regulator' || edge.role === 'catalyst' ? edge.target : edge.source)}><Icon name="edit" /> Edit reaction participants</button></>}
        {edge.origin === 'step' && <div className="small">The reaction is a step of this pathway. Membership does not say anything about order.</div>}
        {edge.origin === 'order' && <div className="small">Order defined for this pathway ({edge.evidence === 'database_annotated' ? 'from a curated source' : 'defined by a researcher'}).</div>}
      </div>
      {editR && <ReactionEditor reactionId={editR} onClose={() => setEditR(null)} onSaved={onChanged} />}
    </aside>
  );
}
void navigate;
