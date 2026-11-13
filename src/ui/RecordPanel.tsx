import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Field, Provenance, RecordRow, RelationRef } from '../../shared/types.ts';
import { del, get, patch, post } from '../lib/api.ts';
import { Link, navigate } from '../lib/router.tsx';
import { Hint } from './Tip.tsx';
import { toast, useEvent } from '../lib/store.ts';
import { CellView, NOT_EDITABLE, RelationEditor, SelectEditor, SequenceModalBody, UserEditor, InlineInput } from './Cells.tsx';
import { Chip, ErrorBoundary, EvidenceDetail, EvidenceTag, Modal, Spinner, StatusChip, ago, confirmDialog, fmtDate } from './common.tsx';
import { FIELD_ICON, Icon } from './icons.tsx';
import { KIND_ICON } from './icons.tsx';
import type { JobInfo } from '../../shared/types.ts';
import { useSession } from '../lib/store.ts';
import { RecordRelations } from './explorer/RecordRelations.tsx';

const StructureViewer = lazy(() => import('./Structure.tsx').then((m) => ({ default: m.StructureViewer })));
const GraphView = lazy(() => import('./GraphView.tsx').then((m) => ({ default: m.GraphView })));

interface Loaded {
  record: RecordRow;
  table: { id: string; name: string; kind: string; projectId: string | null; workspaceId: string; level: string };
  fields: Field[]; provenance: (Provenance & { sourceDb: string; retrievedAt: string })[];
  comments: { id: string; body: string; createdAt: string; author: string; authorId: string }[];
}

export function RecordPanel({ recordId, onClose, onOpenOther }: { recordId: string; onClose: () => void; onOpenOther?: (id: string) => void }) {
  const [d, setD] = useState<Loaded | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => { get<Loaded>(`/api/records/${recordId}`).then((r) => { setD(r); setErr(''); }, (e) => setErr(e.message)); }, [recordId]);
  useEffect(() => { setD(null); load(); }, [load]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(load, 150); };
  useEvent('record.changed', soon, [recordId]);
  useEvent('comment.added', (e) => { if (e.recordId === recordId) soon(); }, [recordId]);
  const [graph, setGraph] = useState(false);
  const [depth, setDepth] = useState(2);

  if (err) return <aside className="rp"><header><h2>Record</h2><button className="btn ghost icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button></header><div className="empty"><b>Cannot open this record</b>{err}</div></aside>;
  if (!d) return <aside className="rp"><header><h2><Spinner /></h2><button className="btn ghost icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button></header></aside>;
  const { record, table, fields } = d;
  const canEdit = table.level === 'editor' || table.level === 'admin';
  const primary = fields[0];
  const name = record.fields[primary.id] !== undefined ? String(record.fields[primary.id]) : '(unnamed)';
  const rels = fields.filter((f) => f.type === 'relation');
  const others = fields.filter((f) => f.type !== 'relation');
  const open = (id: string) => (onOpenOther ? onOpenOther(id) : navigate(`/record/${id}`));
  const saveField = async (f: Field, value: unknown) => {
    try { const r = await patch(`/api/records/${record.id}`, { fields: { [f.id]: value }, createChoices: true }); setD((x) => (x ? { ...x, record: r.record } : x)); }
    catch (e) { toast((e as Error).message, 'err'); }
  };
  const accessionField = fields.find((f) => f.key === 'accession');
  const accession = accessionField ? String(record.fields[accessionField.id] ?? '') : '';
  const structureField = fields.find((f) => f.type === 'structure');
  const sv = structureField ? (record.fields[structureField.id] as any) : null;

  return (
    <aside className="rp" aria-label="Record details">
      <header>
        <span style={{ color: 'var(--brand)', paddingTop: 3 }}><Icon name={KIND_ICON[table.kind] ?? 'grid'} size={20} /></span>
        <div className="grow"><h2>{name}</h2><div className="muted small">{table.name} · updated {ago(record.updatedAt)}</div></div>
        <button className="btn ghost icon sm" onClick={() => setGraph(true)} title="Relationship graph" aria-label="Open relationship graph"><Icon name="graph" /></button>
        <button className="btn ghost icon sm" onClick={() => navigator.clipboard?.writeText(`${location.origin}/record/${record.id}`).then(() => toast('Link copied', 'ok'))} title="Copy link" aria-label="Copy link"><Icon name="link" /></button>
        {canEdit && <button className="btn ghost icon sm" aria-label="Delete record" title="Delete record" onClick={async () => { if (await confirmDialog('Delete this record? Its links to other records are removed too.', 'Delete record')) { await del(`/api/records/${record.id}`); toast('Record deleted', 'ok'); onClose(); } }}><Icon name="trash" /></button>}
        <button className="btn ghost icon sm" onClick={onClose} aria-label="Close panel"><Icon name="x" /></button>
      </header>
      <div className="body">
        <Discover record={record} table={table} fields={fields} canEdit={canEdit} accession={accession} />
        <section>
          <h3>Fields</h3>
          {others.map((f) => <FieldRow key={f.id} f={f} v={record.fields[f.id]} canEdit={canEdit && !NOT_EDITABLE.has(f.type)} onSave={(v) => saveField(f, v)} />)}
        </section>
        {['dna', 'rna', 'gene', 'protein', 'chemical', 'structure', 'organism', 'publication', 'reaction', 'pathway'].includes(table.kind) && <RecordRelations recordId={record.id} name={name} kind={table.kind} canEdit={canEdit} onOpen={open} />}
        {rels.length > 0 && (
          <section>
            <h3><Icon name="link" size={13} /> Linked records</h3>
            {rels.map((f) => <LinkSection key={f.id} f={f} refs={(record.fields[f.id] as RelationRef[]) ?? []} recordId={record.id} canEdit={canEdit} onOpen={open} onChange={load} />)}
          </section>
        )}
        {(accession && table.kind === 'protein' && /^[A-Z][0-9][A-Z0-9]{3}[0-9]|^[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2}/.test(accession.replace(/-\d+$/, ''))) && <Struct3D src="alphafold" id={accession.replace(/-\d+$/, '')} title={name} label="AlphaFold structure" />}
        {sv?.source === 'alphafold' && sv.uniprot && <Struct3D src="alphafold" id={sv.uniprot} title={name} label="3D structure" autoOpen />}
        {sv?.source === 'pdb' && <Struct3D src="pdb" id={sv.id} title={name} label="3D structure" autoOpen />}
        <section>
          <h3><Icon name="clock" size={13} /> Provenance & processing history</h3>
          {d.provenance.length === 0 ? <div className="muted small">This record was created by hand. Imported records list where each value came from.</div> : (
            <div className="tl">{[...d.provenance].reverse().map((p) => (
              <div key={p.id}>
                <div className="row wrap" style={{ gap: 6 }}><b>{p.sourceDb}</b><Chip color="gray">{p.step}</Chip><span className="muted small">{fmtDate(p.retrievedAt, true)}</span></div>
                <div className="small">{p.accession && <span className="mono">{p.accession}</span>}{p.query && p.query !== p.accession && <> · query “{p.query}”</>}{p.url && <> · <a href={p.url} target="_blank" rel="noreferrer noopener">source ↗</a></>}</div>
                {p.note && <div className="small muted">{p.note}</div>}
              </div>
            ))}</div>
          )}
        </section>
        <Comments recordId={record.id} comments={d.comments} canComment onChange={load} />
      </div>
      {graph && (
        <Modal title={`Relationships of ${name}`} onClose={() => setGraph(false)} size="wide">
          <div style={{ height: '60vh', display: 'flex', flexDirection: 'column' }}><Suspense fallback={<Spinner />}><GraphView source={{ kind: 'record', id: record.id }} depth={depth} onDepth={setDepth} onOpen={(id) => { setGraph(false); if (id !== record.id) open(id); }} /></Suspense></div>
        </Modal>
      )}
    </aside>
  );
}

function Struct3D({ src, id, title, label, autoOpen }: { src: 'alphafold' | 'pdb'; id: string; title: string; label: string; autoOpen?: boolean }) {
  const [on, setOn] = useState(!!autoOpen);
  return (
    <section>
      <h3><Icon name="cube" size={13} /> {label}</h3>
      {on ? <ErrorBoundary label="The 3D viewer could not start"><Suspense fallback={<Spinner label="Loading viewer…" />}><StructureViewer src={src} id={id} title={title} /></Suspense></ErrorBoundary>
        : <button className="btn secondary sm" onClick={() => setOn(true)}><Icon name="play" /> Open 3D viewer</button>}
    </section>
  );
}

function FieldRow({ f, v, canEdit, onSave }: { f: Field; v: unknown; canEdit: boolean; onSave: (v: unknown) => void }) {
  const [edit, setEdit] = useState(false);
  const [seq, setSeq] = useState<string | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  const startEdit = () => { if (!canEdit) return; if (f.type === 'checkbox') { onSave(!v); return; } if (f.type === 'sequence') { setSeq(String(v ?? '')); return; } if (f.type === 'structure' || f.type === 'attachment') return; setEdit(true); };
  return (
    <div className="frow">
      <div className="k"><Icon name={FIELD_ICON[f.type] ?? 'text'} size={13} />{f.name}</div>
      <div className="v">
        {edit && ['text', 'number', 'url', 'date'].includes(f.type) ? (
          <div style={{ position: 'relative', height: 32 }}><InlineInput field={f} value={v} onCommit={(x) => { setEdit(false); onSave(x); }} onCancel={() => setEdit(false)} /></div>
        ) : edit && f.type === 'longtext' ? (
          <LongText value={String(v ?? '')} onCommit={(x) => { setEdit(false); onSave(x || null); }} />
        ) : (
          <div ref={anchor} className={`vbox${canEdit ? '' : ' ro'}`} tabIndex={canEdit ? 0 : undefined} onClick={startEdit} onKeyDown={(e) => { if (e.key === 'Enter') startEdit(); }} role={canEdit ? 'button' : undefined} aria-label={canEdit ? `Edit ${f.name}` : undefined}>
            {empty ? <span className="muted">{canEdit ? 'Empty' : '—'}</span> : f.type === 'longtext' ? <span style={{ whiteSpace: 'pre-wrap' }}>{String(v)}</span> : f.type === 'sequence' ? <span className="seq" style={{ wordBreak: 'break-all', whiteSpace: 'normal' }}>{String(v).slice(0, 400)}{String(v).length > 400 ? `… (${String(v).length.toLocaleString()} ${f.options.seqType === 'protein' ? 'aa' : 'bp'})` : ''}</span> : <CellView field={f} value={v} />}
          </div>
        )}
        {edit && ['singleSelect', 'multiSelect', 'status'].includes(f.type) && <SelectEditor anchor={anchor} field={f} value={v} onCommit={(x) => { onSave(x); }} onClose={() => setEdit(false)} />}
        {edit && f.type === 'user' && <UserEditor anchor={anchor} value={v} onCommit={(x) => onSave(x)} onClose={() => setEdit(false)} />}
        {seq !== null && <Modal title={`Edit ${f.name}`} onClose={() => setSeq(null)} footer={<><button className="btn secondary" onClick={() => setSeq(null)}>Cancel</button><button className="btn" onClick={() => { onSave(seq.replace(/^>.*$/gm, '').replace(/\s+/g, '') || null); setSeq(null); }}>Save</button></>}><SequenceModalBody value={seq} seqType={f.options.seqType} onChange={setSeq} /></Modal>}
      </div>
    </div>
  );
}
function LongText({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [t, setT] = useState(value);
  return <div className="col" style={{ gap: 4 }}><textarea className="textarea" autoFocus rows={5} value={t} onChange={(e) => setT(e.target.value)} /><div className="row"><button className="btn sm" onClick={() => onCommit(t)}>Save</button><button className="btn ghost sm" onClick={() => onCommit(value)}>Cancel</button></div></div>;
}

function LinkSection({ f, refs, recordId, canEdit, onOpen, onChange }: { f: Field; refs: RelationRef[]; recordId: string; canEdit: boolean; onOpen: (id: string) => void; onChange: () => void }) {
  const [pick, setPick] = useState(false);
  const [openEv, setOpenEv] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const apply = async (ids: string[]) => { try { await patch(`/api/records/${recordId}`, { fields: { [f.id]: ids } }); onChange(); } catch (e) { toast((e as Error).message, 'err'); } };
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row between"><b className="small">{f.name} <span className="muted">({refs.length})</span></b>{canEdit && <><button ref={btn} className="btn ghost sm" onClick={() => setPick(true)}><Icon name="plus" /> Link</button>{pick && <RelationEditor anchor={btn} field={f} value={refs} onCommit={(ids) => void apply(ids)} onClose={() => setPick(false)} />}</>}</div>
      {refs.length === 0 && <div className="muted small">No linked records.</div>}
      {refs.map((r) => (
        <div key={r.id}>
          <div className="linkrow">
            <button className="btn ghost sm" style={{ padding: '0 6px', fontWeight: 500 }} onClick={() => onOpen(r.id)}>{r.name}</button>
            {r.meta?.relationType && <Chip color="sky">{r.meta.relationType}</Chip>}
            <span className="grow" />
            <EvidenceTag cls={r.meta?.evidenceClass ?? 'unverified'} />
            <button className="btn ghost icon sm" onClick={() => setOpenEv(openEv === r.id ? null : r.id)} aria-label="Show evidence" aria-expanded={openEv === r.id}><Icon name={openEv === r.id ? 'chevU' : 'info'} /></button>
          </div>
          {openEv === r.id && (r.meta ? <div style={{ margin: '0 0 6px 6px' }}><EvidenceDetail meta={r.meta} />{canEdit && (r.meta.evidenceClass === 'user_supplied' || r.meta.evidenceClass === 'unverified') && <UserEvidence fieldId={f.id} recordId={recordId} targetId={r.id} meta={r.meta} onSaved={onChange} />}</div> : <div className="muted small" style={{ margin: '0 0 6px 6px' }}>No evidence recorded for this link.</div>)}
        </div>
      ))}
    </div>
  );
}
function UserEvidence({ fieldId, recordId, targetId, meta, onSaved }: { fieldId: string; recordId: string; targetId: string; meta: any; onSaved: () => void }) {
  const [t, setT] = useState(meta.evidence ?? ''); const [rt, setRt] = useState(meta.relationType ?? ''); const [cls, setCls] = useState(meta.evidenceClass ?? 'user_supplied'); const [u, setU] = useState(meta.referenceUrl ?? '');
  return (
    <div className="col" style={{ marginTop: 6 }}>
      <div className="row"><input className="input" placeholder="Relationship (e.g. inhibitor)" value={rt} onChange={(e) => setRt(e.target.value)} aria-label="Relationship type" /><select className="select" style={{ width: 160 }} value={cls} onChange={(e) => setCls(e.target.value)} aria-label="Evidence class"><option value="user_supplied">User supplied</option><option value="unverified">Unverified</option></select></div>
      <input className="input" placeholder="Evidence note" value={t} onChange={(e) => setT(e.target.value)} aria-label="Evidence note" />
      <input className="input" placeholder="Reference URL (https://…)" value={u} onChange={(e) => setU(e.target.value)} aria-label="Reference URL" />
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={async () => { try { await patch('/api/links/evidence', { fieldId, recordId, targetId, evidenceClass: cls, relationType: rt, evidence: t, referenceUrl: u }); toast('Evidence saved', 'ok'); onSaved(); } catch (e) { toast((e as Error).message, 'err'); } }}>Save evidence</button>
    </div>
  );
}

/** Context-aware discovery actions. Every action is a background job; progress shows inline and notifications fire on completion. */
function Discover({ record, table, canEdit, accession, fields }: { record: RecordRow; table: Loaded['table']; fields: Field[]; canEdit: boolean; accession: string }) {
  const [jobs, setJobs] = useState<string[]>([]);
  const k = table.kind;
  const geneId = fields.find((f) => f.key === 'geneId'); const hasGeneId = !!geneId && !!record.fields[geneId.id];
  const seqF = fields.find((f) => f.key === 'sequence'); const hasSeq = !!seqF && !!record.fields[seqF.id];
  const run = async (what: string, label: string) => {
    try { const r = await post(`/api/records/${record.id}/discover`, { what }); setJobs((j) => [r.jobId, ...j].slice(0, 4)); toast(`${label} started – you will be notified when it finishes`, 'info', { to: `/jobs/${r.jobId}`, label: 'View job' }); }
    catch (e) { toast((e as Error).message, 'err'); }
  };
  if (!canEdit || !['dna', 'rna', 'gene', 'protein', 'chemical'].includes(k)) return null;
  const HK: Record<string, string> = { metadata: 'discoverMetadata', genes: 'discoverGenes', pipeline: 'discoverPipeline', proteins: 'discoverProteins', structures: 'discoverStructures', chemicals: 'discoverChemicals' };
  const A = (what: string, label: string, icon: string, primary = false, disabled = false, tip?: string) => <Hint key={what} k={HK[what]}><button className={`btn sm ${primary ? '' : 'secondary'}`} disabled={disabled} aria-disabled={disabled} title={tip} onClick={() => void run(what, label)}><Icon name={icon} /> {label}</button></Hint>;
  return (
    <section>
      <h3><Icon name="bolt" size={13} /> Discover</h3>
      <div className="row wrap">
        {(k === 'dna' || k === 'rna') && hasSeq && <Link to={`/lab/${record.id}`} className="btn sm"><Icon name="dna" /> Open in Sequence Lab</Link>}
        {(k === 'dna' || k === 'rna') && <>{A('metadata', 'Fetch NCBI metadata', 'download', false, !accession, 'Needs an accession')}{A('genes', 'Find genes', 'gene', false, !accession && !hasSeq)}{A('pipeline', 'Run full pipeline', 'play', true, !accession && !hasSeq, 'DNA → gene → protein → structure → chemicals')}</>}
        {k === 'gene' && <>{A('metadata', 'Fetch NCBI gene', 'download', false, !hasGeneId, 'Needs an NCBI Gene ID')}{A('proteins', 'Find proteins', 'protein', true, !hasGeneId && !record.fields[fields[0].id])}{A('pipeline', 'Proteins → structures → chemicals', 'play')}</>}
        {k === 'protein' && <>{A('metadata', 'Fetch UniProt entry', 'download', false, !accession)}{A('structures', 'Get structures', 'cube', false, !accession)}{A('chemicals', 'Find chemicals', 'flask', true, !accession)}{A('pipeline', 'Structures + chemicals', 'play', false, !accession)}</>}
        {k === 'chemical' && A('metadata', 'Fetch PubChem metadata', 'download', true)}
      </div>
      {jobs.map((j) => <JobLine key={j} id={j} />)}
    </section>
  );
}

export function JobLine({ id }: { id: string }) {
  const [j, setJ] = useState<JobInfo | null>(null);
  const load = useCallback(() => get(`/api/jobs/${id}`).then((r) => setJ(r.job), () => {}), [id]);
  useEffect(() => { void load(); }, [load]);
  useEvent('job.changed', (e) => { if (e.jobId === id) void load(); }, [id]);
  if (!j) return null;
  return (
    <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
      <StatusChip status={j.status} /><span className="small">{j.name}</span>
      {j.progressTotal ? <span className="small muted">{j.progressDone}/{j.progressTotal}</span> : null}
      <span className="small muted grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.status === 'failed' ? j.error : j.message}</span>
      {(j.status === 'queued' || j.status === 'running') && <button className="btn ghost sm" onClick={() => post(`/api/jobs/${id}/cancel`)}>Cancel</button>}
      <a href={`/jobs/${id}`} onClick={(e) => { e.preventDefault(); navigate(`/jobs/${id}`); }} className="small">Details</a>
    </div>
  );
}

function Comments({ recordId, comments, onChange }: { recordId: string; comments: Loaded['comments']; canComment: boolean; onChange: () => void }) {
  const [t, setT] = useState('');
  const me = useSession((s) => s.user?.id);
  return (
    <section>
      <h3>Comments ({comments.length})</h3>
      {comments.map((c) => (
        <div key={c.id} style={{ marginBottom: 8 }}>
          <div className="row small"><b>{c.author}</b><span className="muted">{ago(c.createdAt)}</span>{c.authorId === me && <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={async () => { await del(`/api/comments/${c.id}`); onChange(); }} aria-label="Delete comment"><Icon name="trash" size={13} /></button>}</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
        </div>
      ))}
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <textarea className="textarea" rows={2} placeholder="Add a comment…" value={t} onChange={(e) => setT(e.target.value)} aria-label="Comment" />
        <button className="btn sm" disabled={!t.trim()} onClick={async () => { try { await post(`/api/records/${recordId}/comments`, { body: t }); setT(''); onChange(); } catch (e) { toast((e as Error).message, 'err'); } }}>Post</button>
      </div>
    </section>
  );
}
