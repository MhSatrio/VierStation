import { useEffect, useRef, useState } from 'react';
import { get, post } from '../lib/api.ts';
import { Link, navigate } from '../lib/router.tsx';
import { refreshTables, toast, useEvent, useSession } from '../lib/store.ts';
import { Chip, Modal, Spinner, useDebounced } from './common.tsx';
import { KIND_ICON, Icon } from './icons.tsx';
import { JobLine } from './RecordPanel.tsx';

interface LocalHit { recordId: string; tableId: string; tableName: string; kind: string; title: string; snippet: string; projectId: string | null }
interface Hit { db: string; id: string; kind: string; title: string; subtitle: string; organism?: string; url: string; importable: boolean; badges?: string[] }
interface SciResp { query: string; interpreted: { type: string; detail: string }; hits: Hit[]; errors: { db: string; message: string }[]; tookMs: number; sequence?: { kind: 'dna' | 'protein'; length: number; fasta: boolean } }
interface DbInfo { id: string; label: string; note: string; slow?: boolean }

export function SearchModal({ onClose }: { onClose: () => void }) {
  const { wsId, projectId, projectName } = useSession((s) => ({ wsId: s.wsId, projectId: s.projectId, projectName: s.projects.find((p) => p.id === s.projectId)?.name ?? '—' }));
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 160);
  const [local, setLocal] = useState<LocalHit[]>([]);
  const [localMs, setLocalMs] = useState<number | null>(null);
  const [sci, setSci] = useState<SciResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [dbs, setDbs] = useState<DbInfo[]>([]);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState<Record<string, string>>({});
  const [seqJob, setSeqJob] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); get('/api/search/databases').then((r) => { setDbs(r.databases); setOn(new Set(r.defaults)); }, () => {}); }, []);
  // instant local search (SQLite FTS5)
  useEffect(() => {
    if (!wsId || dq.trim().length < 2 || dq.length > 200 || /^>|^[ACGTUNacgtun\s]{25,}$/.test(dq)) { setLocal([]); setLocalMs(null); return; }
    let live = true;
    get(`/api/workspaces/${wsId}/search?q=${encodeURIComponent(dq)}`).then((r) => { if (live) { setLocal(r.hits); setLocalMs(r.tookMs); } }, () => {});
    return () => { live = false; };
  }, [dq, wsId]);
  useEffect(() => { setSci(null); setSeqJob(null); }, [q]);

  const runSci = async () => {
    if (!q.trim()) return;
    setBusy(true); setSci(null);
    try { setSci(await post('/api/search', { query: q, dbs: [...on] })); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  const importHit = async (h: Hit) => {
    if (!projectId) { toast('Create or select a project first', 'err'); return; }
    const key = `${h.db}:${h.id}`;
    setImporting((m) => ({ ...m, [key]: 'working' }));
    try {
      const dbMap: Record<string, string> = { nuccore: 'nuccore', gene: 'gene', uniprot: 'uniprot', pubchem: 'pubchem', pdb: 'pdb' };
      const r = await post('/api/import/hit', { projectId, db: dbMap[h.db], id: h.id });
      setImporting((m) => ({ ...m, [key]: r.jobId }));
      toast(`Importing ${h.id}…`, 'info', { to: `/jobs/${r.jobId}`, label: 'View job' });
    } catch (e) { setImporting((m) => ({ ...m, [key]: '' })); toast((e as Error).message, 'err'); }
  };
  useEvent('job.changed', (e) => { if (e.status === 'completed') void refreshTables(); });

  const startSeq = async (action: 'import' | 'pipeline' | 'search') => {
    if (!projectId || !wsId) return;
    try {
      if (action === 'search') { const r = await post('/api/search/sequence', { workspaceId: wsId, sequence: q }); setSeqJob(r.jobId); return; }
      const r = await post('/api/import/fasta', { projectId, text: q });
      toast('Sequence import started', 'info', { to: `/jobs/${r.jobId}`, label: 'View job' });
      if (action === 'pipeline') {
        // chain: when the import job completes, start the pipeline on the new record
        const t0 = Date.now();
        const timer = setInterval(async () => {
          const j = (await get(`/api/jobs/${r.jobId}`)).job;
          if (j.status === 'completed') { clearInterval(timer); const rid = j.result?.records?.[0]?.recordId; if (rid) { const p = await post(`/api/records/${rid}/discover`, { what: 'pipeline' }); toast('Discovery pipeline started', 'info', { to: `/jobs/${p.jobId}`, label: 'View job' }); } }
          else if (j.status === 'failed' || Date.now() - t0 > 60_000) clearInterval(timer);
        }, 800);
      }
      onClose();
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  const importCoords = async () => { try { const r = await post('/api/import/accession', { projectId, value: q.trim() }); toast('Fetching region…', 'info', { to: `/jobs/${r.jobId}`, label: 'View job' }); onClose(); } catch (e) { toast((e as Error).message, 'err'); } };

  return (
    <Modal title="Search" size="wide" onClose={onClose}>
      <div className="col" style={{ minHeight: 360 }}>
        <div className="row">
          <div style={{ position: 'relative' }} className="grow">
            <input ref={input} className="input" style={{ paddingLeft: 32, minHeight: 40, fontSize: '1.02rem' }} placeholder="Accession, gene symbol, protein, chemical, InChIKey, PDB ID, sequence (FASTA)…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void runSci(); } }} aria-label="Search" />
            <span style={{ position: 'absolute', left: 10, top: 12, color: 'var(--ink-3)' }}><Icon name="search" /></span>
          </div>
          <button className="btn" onClick={runSci} disabled={busy || !q.trim()}>{busy ? <span className="spinner" style={{ borderTopColor: '#fff' }} /> : <Icon name="database" />} Search databases</button>
        </div>
        <div className="row wrap" style={{ gap: 4 }} aria-label="Databases to search">
          {dbs.map((d) => <button key={d.id} className={`chip ${on.has(d.id) ? 'blue' : 'gray'} link`} style={{ border: 0, height: 24 }} title={d.note} aria-pressed={on.has(d.id)} onClick={() => setOn((s) => { const n = new Set(s); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })}>{on.has(d.id) ? '✓ ' : ''}{d.label}{d.slow ? ' ⏱' : ''}</button>)}
        </div>

        {local.length > 0 && (
          <div>
            <div className="small muted" style={{ margin: '4px 0' }}>In your workspace · {localMs} ms</div>
            {local.map((h) => <Link key={h.recordId} to={`/record/${h.recordId}`} onClick={onClose} className="hit" style={{ color: 'inherit', textDecoration: 'none' }}><span className="ico"><Icon name={KIND_ICON[h.kind] ?? 'grid'} /></span><span className="grow"><span className="ttl">{h.title}</span><br /><span className="muted small">{h.tableName} · {h.snippet.replace(/\[|\]/g, '')}</span></span></Link>)}
          </div>
        )}
        {busy && <div className="muted"><Spinner label="Searching selected databases (ChEMBL and BindingDB can take 20 s or more)…" /></div>}
        {sci && (
          <div>
            <div className="small muted" style={{ margin: '4px 0' }}>Scientific databases · {sci.interpreted.detail} · {(sci.tookMs / 1000).toFixed(1)} s</div>
            {sci.sequence && (
              <div className="evbox" style={{ margin: '6px 0' }}>
                <b>{sci.sequence.kind === 'dna' ? 'DNA/RNA' : 'Protein'} sequence · {sci.sequence.length.toLocaleString()} {sci.sequence.kind === 'dna' ? 'nt' : 'aa'}</b>
                <div className="row wrap">
                  <button className="btn sm" onClick={() => startSeq('search')} disabled={!!seqJob}><Icon name="search" /> Search by sequence (BLAST)</button>
                  {sci.sequence.kind === 'dna' && <><button className="btn secondary sm" onClick={() => startSeq('import')}><Icon name="plus" /> Add as DNA record</button><button className="btn secondary sm" onClick={() => startSeq('pipeline')}><Icon name="play" /> Add & run pipeline</button></>}
                </div>
                {sci.sequence.kind === 'protein' && <span className="muted small">Protein sequences are searched against Swiss-Prot by BLASTP; import the matching UniProt entry afterwards.</span>}
                {seqJob && <><JobLine id={seqJob} /><SeqHits jobId={seqJob} onImport={importHit} /></>}
              </div>
            )}
            {sci.interpreted.type === 'coordinates' && <div className="evbox" style={{ margin: '6px 0' }}><b>Genomic coordinates</b><div className="small">Fetch this region from NCBI as a DNA record with its annotated genes.</div><button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={importCoords}><Icon name="download" /> Import region</button></div>}
            {sci.hits.length === 0 && !sci.sequence && sci.interpreted.type !== 'coordinates' && <div className="muted" style={{ padding: 8 }}>No matches in the selected databases.</div>}
            {sci.hits.map((h) => {
              const key = `${h.db}:${h.id}`, state = importing[key];
              return (
                <div key={key} className="hit">
                  <span className="ico"><Icon name={KIND_ICON[h.kind] ?? 'grid'} /></span>
                  <div className="grow"><div className="ttl">{h.title}</div><div className="small muted">{h.subtitle}{h.organism ? ` · ${h.organism}` : ''}</div>
                    <div className="row wrap" style={{ gap: 4, marginTop: 2 }}><Chip color="blue">{h.db}</Chip>{h.badges?.filter(Boolean).map((b) => <Chip key={b} color={b === 'predicted' ? 'amber' : b === 'experimental' ? 'green' : 'gray'}>{b}</Chip>)}<a className="small" href={h.url} target="_blank" rel="noreferrer noopener">Open source ↗</a></div></div>
                  {h.importable && (state && state !== 'working' ? <span className="small"><JobLine id={state} /></span> : <button className="btn secondary sm" disabled={state === 'working'} onClick={() => void importHit(h)}><Icon name="plus" /> Add to project</button>)}
                </div>
              );
            })}
            {sci.errors.length > 0 && <div className="notice warn" style={{ marginTop: 8 }}>{sci.errors.map((e) => `${e.db}: ${e.message}`).join(' · ')} — other sources are shown above.</div>}
          </div>
        )}
        {!q.trim() && (
          <div className="muted small" style={{ lineHeight: 1.7 }}>
            Type to search your records instantly. Press <kbd className="mono">Enter</kbd> to also search NCBI, UniProt, AlphaFold DB, PubChem, RCSB PDB and InterPro (ChEMBL and BindingDB are opt-in because they can be slow).
            <br />Examples: <button className="chip sky link" style={{ border: 0 }} onClick={() => setQ('NM_000546')}>NM_000546</button> <button className="chip sky link" style={{ border: 0 }} onClick={() => setQ('P04637')}>P04637</button> <button className="chip sky link" style={{ border: 0 }} onClick={() => setQ('BRCA1')}>BRCA1</button> <button className="chip sky link" style={{ border: 0 }} onClick={() => setQ('imatinib')}>imatinib</button> <button className="chip sky link" style={{ border: 0 }} onClick={() => setQ('1IEP')}>1IEP</button> <button className="chip sky link" style={{ border: 0 }} onClick={() => setQ('KTUFNOKKBVMGRW-UHFFFAOYSA-N')}>InChIKey</button>
          </div>
        )}
        {!projectId && <div className="notice warn">Create a project first to add records.</div>}
        <span className="muted small">Add to project imports the record into <b>{projectName}</b> as a background job.</span>
      </div>
    </Modal>
  );
  void navigate;
}

function SeqHits({ jobId, onImport }: { jobId: string; onImport: (h: Hit) => void }) {
  const [hits, setHits] = useState<{ accession: string; title: string; organism: string; identityPct: number; coveragePct: number; db: string }[]>([]);
  const load = () => get(`/api/jobs/${jobId}`).then((r) => { if (r.job.status === 'completed') setHits(r.job.result?.hits ?? []); }, () => {});
  useEffect(() => { void load(); }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvent('job.changed', (e) => { if (e.jobId === jobId) void load(); }, [jobId]);
  if (!hits.length) return null;
  return (
    <table className="t"><thead><tr><th>Match</th><th>Identity</th><th>Coverage</th><th /></tr></thead><tbody>
      {hits.map((h) => <tr key={h.accession}><td><b>{h.accession}</b><div className="small muted">{h.title} {h.organism && `· ${h.organism}`}</div></td><td>{h.identityPct}%</td><td>{h.coveragePct}%</td><td><button className="btn secondary sm" onClick={() => onImport({ db: h.db, id: h.accession, kind: 'dna', title: h.title, subtitle: '', url: '', importable: true })}>Add to project</button></td></tr>)}
    </tbody></table>
  );
}
