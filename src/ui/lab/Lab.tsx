// Sequence Lab: per-sequence workspace (import → inspect → clean → BLAST → relatives → outgroups → align → tree → identify) with full history.
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, get, post } from '../../lib/api.ts';
import { Link, navigate, setQuery, useQueryParam } from '../../lib/router.tsx';
import { toast, useEvent, useSession } from '../../lib/store.ts';
import { Chip, Empty, Modal, Spinner, ago } from '../common.tsx';
import { Icon } from '../icons.tsx';
import { HelpTip, Hint } from '../Tip.tsx';
import { LabCtx, act } from './useLab.tsx';
import { Cleaning, Overview, Quality, Raw } from './sections1.tsx';
import { Alignment, Matches, Outgroups, Relatives } from './sections2.tsx';
import { Exports, Final, History, TreeSection } from './sections3.tsx';
import { MergeDialog, PickDialog } from './pickers.tsx';

const NAV: { group: string; items: { key: string; label: string; step?: string[] }[] }[] = [
  { group: 'Prepare', items: [{ key: 'overview', label: 'Overview' }, { key: 'raw', label: 'Raw sequence', step: ['import'] }, { key: 'quality', label: 'Quality inspection' }, { key: 'cleaning', label: 'Cleaning', step: ['clean'] }] },
  { group: 'Find relatives', items: [{ key: 'matches', label: 'NCBI matches', step: ['blast'] }, { key: 'relatives', label: 'Related species', step: ['relatives', 'dataset'] }, { key: 'outgroups', label: 'Outgroups', step: ['outgroups'] }] },
  { group: 'Analyse', items: [{ key: 'alignment', label: 'Alignment', step: ['align', 'align_edit'] }, { key: 'tree', label: 'Phylogenetic tree', step: ['tree'] }] },
  { group: 'Conclude', items: [{ key: 'final', label: 'Final identification', step: ['identify'] }, { key: 'history', label: 'Workflow history' }, { key: 'exports', label: 'Exports' }] },
];

export function Lab({ id }: { id?: string }) {
  if (!id) return <LabHome />;
  return <LabRecord key={id} id={id} />;
}

function LabRecord({ id }: { id: string }) {
  const section = useQueryParam('section') ?? 'overview';
  const [ov, setOv] = useState<any>(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(async () => { try { setOv(await get(`/api/lab/${id}`)); setErr(''); } catch (e) { setErr((e as Error).message); } }, [id]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEvent('record.changed', (e) => { if (e.ids?.includes?.(id)) void refresh(); }, [id, refresh]);
  const bump = useCallback(() => { setTick((t) => t + 1); void refresh(); }, [refresh]);
  const go = useCallback((s: string) => setQuery('section', s, false), []);
  if (err) return <div className="page"><Empty title="Cannot open the Sequence Lab for this record">{err}<br /><Link to="/lab">Back to the Sequence Lab</Link></Empty></div>;
  if (!ov) return <div className="page"><Spinner label="Opening…" /></div>;
  if (ov.adoptable) return <div className="page"><Empty title="This record is not in the Sequence Lab">You need editor access to start a history for it.</Empty></div>;
  const statusOf = (steps?: string[]) => { if (!steps) return ''; const xs = steps.map((s) => ov.steps[s]).filter(Boolean).sort((a: any, b: any) => (a.at < b.at ? 1 : -1)); const x = xs[0]; return !x ? '' : x.status === 'running' ? 'run' : x.status === 'failed' ? 'fail' : x.status === 'completed' ? 'done' : ''; };
  const ctx = { id, ov, refresh, tick, bump, canEdit: !!ov.canEdit, go };
  const body = { overview: <Overview />, raw: <Raw />, quality: <Quality />, cleaning: <Cleaning />, matches: <Matches />, relatives: <Relatives />, outgroups: <Outgroups />, alignment: <Alignment />, tree: <TreeSection />, final: <Final />, history: <History />, exports: <Exports /> }[section] ?? <Overview />;
  return (
    <LabCtx.Provider value={ctx}>
      <div className="page fill" style={{ overflow: 'hidden' }}>
        <div className="lab">
          <nav className="lab-nav" aria-label="Sequence Lab sections">
            {NAV.map((g) => (
              <div key={g.group} className="col" style={{ gap: 2 }}><h3>{g.group}</h3>
                {g.items.map((it) => <button key={it.key} className={section === it.key ? 'on' : ''} onClick={() => go(it.key)} aria-current={section === it.key ? 'page' : undefined}><i className={`st ${statusOf(it.step)}`} aria-hidden="true" /><span>{it.label}</span></button>)}
              </div>))}
          </nav>
          <div className="lab-body">
            <div className="lab-head">
              <h1>{ov.name}</h1>
              <Chip color="sky">{ov.head.length} bp</Chip><Hint k="version"><Chip color="gray">version {ov.head.n}</Chip></Hint>
              {ov.meta?.source && <Chip color="gray">{ov.meta.source}</Chip>}{ov.links?.mergedInto?.length > 0 && <Chip color="amber">source read of a merge</Chip>}
              <span className="grow" />
              <Link to={`/map?lab=${id}`} className="btn ghost sm">Show map</Link><Link to={`/record/${id}`} className="btn ghost sm">Open record</Link><Link to="/lab" className="btn ghost sm">All sequences</Link>
            </div>
            <div className="small muted" style={{ marginTop: -6, marginBottom: 12 }}>Sections can be used in any order and repeated – a repeat creates a new result and keeps the old one. <HelpTip k="workingSequence" text="Alignments, BLAST searches and trees use the working sequence (the latest cleaned version), never the raw one. The coloured dot in the menu shows whether a step has results, is running or failed." /></div>
            {body}
          </div>
        </div>
      </div>
    </LabCtx.Provider>
  );
}

// ------------------------------------------------------------------ home + import
function LabHome() {
  const { projectId } = useSession((s) => ({ projectId: s.projectId }));
  const [list, setList] = useState<any[] | null>(null);
  const [imp, setImp] = useState(false);
  const [pick, setPick] = useState(false);
  const [merge, setMerge] = useState(false);
  const load = useCallback(() => { get(`/api/lab${projectId ? `?project=${projectId}` : ''}`).then((r) => setList(r.records), () => setList([])); }, [projectId]);
  useEffect(load, [load]);
  return (
    <div className="page">
      <div className="row between wrap"><h1>Sequence Lab</h1><div className="row wrap"><button className="btn secondary" onClick={() => setPick(true)}>Open from DNA table…</button><button className="btn secondary" onClick={() => setMerge(true)}>Merge forward + reverse…</button><button className="btn" onClick={() => setImp(true)}><Icon name="upload" /> Import sequence…</button></div></div>
      <p className="lead">Identify a DNA sequence step by step: inspect the read, clean it, search NCBI, collect related species and outgroups, align, build a tree – with every step recorded so you can understand, repeat and export it.</p>
      <div className="notice small" style={{ marginBottom: 14 }}>Accepts pasted sequence, FASTA, FASTQ and Sanger <b>.ab1</b> chromatograms. The raw data is stored unchanged; cleaning always creates new versions. Existing DNA records can be opened with <b>Open from DNA table</b> or from their record panel. A forward and a reverse read are combined with <b>Merge forward + reverse</b> into <b>one</b> new sequence; the two reads stay in the DNA table and are listed under it.</div>
      {list === null ? <Spinner /> : list.length === 0 ? <Empty title="No sequences in the lab yet">Import a read or open an existing DNA record.</Empty> : (
        <div className="panel"><table className="t"><thead><tr><th>Sequence</th><th>Length</th><th>Source</th><th>Last change</th></tr></thead><tbody>{list.filter((r) => !r.mergedInto).map((r) => (
          <Fragment key={r.id}>
            <tr className="hitrow" onClick={() => navigate(`/lab/${r.id}`)}><td><Link to={`/lab/${r.id}`}><b>{r.name}</b></Link>{r.mergedFrom && <> <Chip color="blue">merged</Chip></>}</td><td>{r.length}</td><td className="muted small">{r.source}</td><td className="muted small">{ago(r.updatedAt)}</td></tr>
            {r.mergedFrom && ([['forward', r.mergedFrom.forward], ['reverse', r.mergedFrom.reverse]] as const).map(([role, p]) => { const part = list.find((x) => x.id === p.id); return <tr key={r.id + role} className="hitrow subrow" onClick={() => navigate(`/lab/${p.id}`)}><td style={{ paddingLeft: 28 }}><span className="muted small">↳ {role} read: </span><Link to={`/lab/${p.id}`}>{p.name}</Link> <span className="muted small">#{p.id.slice(-6)}</span></td><td className="small">{part?.length ?? ''}</td><td className="muted small">source read (unchanged)</td><td className="muted small">{part ? ago(part.updatedAt) : ''}</td></tr>; })}
          </Fragment>))}</tbody></table></div>)}
      {pick && <PickDialog onClose={() => setPick(false)} />}
      {merge && <MergeDialog onClose={() => { setMerge(false); load(); }} />}
      {imp && <LabImport onClose={() => setImp(false)} onDone={(ids) => { setImp(false); load(); if (ids[0]) navigate(`/lab/${ids[0]}`); }} />}
    </div>
  );
}

export function LabImport({ onClose, onDone }: { onClose: () => void; onDone: (ids: string[]) => void }) {
  const { wsId, projectId } = useSession((s) => ({ wsId: s.wsId, projectId: s.projectId }));
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [meta, setMeta] = useState({ sampleId: '', marker: '', organism: '' });
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const submit = async () => {
    setBusy(true);
    const ids: string[] = []; const notes: string[] = [];
    try {
      if (files.length) {
        for (const f of files) {
          const up = await api('POST', `/api/workspaces/${wsId}/files?name=${encodeURIComponent(f.name)}`, undefined, { raw: await f.arrayBuffer() });
          const r = await post('/api/lab/import', { projectId, fileId: up.file.id, ...meta });
          ids.push(...r.recordIds); if (r.note) notes.push(r.note); if (r.warnings?.length) notes.push(...r.warnings);
        }
      } else {
        const r = await post('/api/lab/import', { projectId, text, ...meta });
        ids.push(...r.recordIds); if (r.warnings?.length) notes.push(...r.warnings);
      }
      toast(`Imported ${ids.length} sequence${ids.length === 1 ? '' : 's'}${notes.length ? ` – ${notes[0]}` : ''}`, 'ok');
      onDone(ids);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  const take = (list: FileList | null) => { if (list) setFiles(Array.from(list)); };
  const can = (files.length > 0 || text.trim().length > 0) && !!projectId;
  return (
    <Modal title="Import a sequence" onClose={onClose} footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !can} onClick={submit}>{busy ? 'Importing…' : 'Import'}</button></>}>
      <div className="col">
        <div className={`dropzone${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}>
          Drop <b>.ab1</b>, FASTA or FASTQ files here, or <button className="btn secondary sm" onClick={() => input.current?.click()}>choose files</button>
          <input ref={input} type="file" hidden multiple accept=".ab1,.abi,.fasta,.fa,.fna,.fastq,.txt" onChange={(e) => take(e.target.files)} />
          {files.length > 0 && <div className="small" style={{ marginTop: 6 }}>{files.map((f) => f.name).join(', ')} <button className="btn ghost sm" onClick={() => setFiles([])}>clear</button></div>}
        </div>
        {files.length === 0 && <label className="field">…or paste a sequence / FASTA / FASTQ<textarea className="textarea mono" rows={6} placeholder={'>isolate_17\nACGTTGCA…'} value={text} onChange={(e) => setText(e.target.value)} /></label>}
        <div className="formgrid">
          <label className="field">Sample ID (optional)<input className="input" value={meta.sampleId} onChange={(e) => setMeta({ ...meta, sampleId: e.target.value })} /></label>
          <label className="field">Marker / gene (optional)<input className="input" placeholder="ITS, COI, 16S, rbcL…" value={meta.marker} onChange={(e) => setMeta({ ...meta, marker: e.target.value })} /></label>
        </div>
        <div className="small muted">Quality scores are kept for AB1 and FASTQ; FASTA and pasted sequences have none, so peaks and quality are never invented. Protein sequences are rejected.</div>
      </div>
    </Modal>
  );
}
void act;
