import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../lib/api.ts';
import { Link, navigate } from '../lib/router.tsx';
import { toast, useEvent, useSession } from '../lib/store.ts';
import { Chip, Empty, Spinner, StatusChip, ago, fmtDate } from './common.tsx';
import { Icon } from './icons.tsx';
import { JobLine } from './RecordPanel.tsx';
import type { JobInfo } from '../../shared/types.ts';

interface Dash {
  recordCount: number; recordsByKind: Record<string, number>; tasks: { total: number; done: number; pending: number; overdue: number; byStatus: Record<string, number> };
  deadlines: { id: string; title: string; due: string; status: string }[]; failedJobs: number; runningJobs: number; statusTotals: Record<string, number>;
  progress: { tasksPct: number | null; recordsPct: number | null }; projectDeadline: string | null; recent: { at: string; kind: string; text: string; link: string }[];
}
const STAGES = [{ k: 'dna', l: 'DNA' }, { k: 'gene', l: 'Genes' }, { k: 'protein', l: 'Proteins' }, { k: 'chemical', l: 'Chemicals' }, { k: 'structure', l: 'Structures' }, { k: 'analysis', l: 'Analyses' }];

export function Overview() {
  const { projectId, projects, wsId, tables } = useSession((s) => ({ projectId: s.projectId, projects: s.projects, wsId: s.wsId, tables: s.tables }));
  const project = projects.find((p) => p.id === projectId);
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState('');
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [acc, setAcc] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!projectId || !wsId) return;
    get(`/api/projects/${projectId}/dashboard`).then((x) => { setD(x); setErr(''); }, (e) => setErr(e.message));
    get(`/api/workspaces/${wsId}/jobs?project=${projectId}&limit=6`).then((r) => setJobs(r.jobs), () => {});
  }, [projectId, wsId]);
  useEffect(() => { setD(null); load(); }, [load]);
  useEvent('job.changed', load, [load]);
  useEvent('record.changed', () => { setTimeout(load, 800); }, [load]);

  if (!project) return (
    <div className="page"><Empty title="Welcome to VierStation"><p>Create a project to start collecting DNA, genes, proteins, chemicals and structures.</p><Link to="/projects?new=1" className="btn">Create a project</Link></Empty></div>
  );
  const kindTable = (k: string) => tables.find((t) => t.projectId === projectId && t.kind === k);
  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!acc.trim()) return;
    setBusy(true);
    try {
      const q = acc.trim();
      if (/^[ACGTUNacgtun\s>]{25,}$/.test(q) || q.startsWith('>')) { const r = await post('/api/import/fasta', { projectId, text: q }); toast('Sequence import started', 'info', { to: `/jobs/${r.jobId}`, label: 'View job' }); }
      else { const r = await post('/api/import/accession', { projectId, value: q }); toast('Fetching from NCBI…', 'info', { to: `/jobs/${r.jobId}`, label: 'View job' }); }
      setAcc('');
    } catch (x) { toast((x as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <div className="row between wrap" style={{ marginBottom: 12 }}>
        <div><h1>{project.name}</h1><div className="muted">{project.description || 'Research project'}{project.deadline ? ` · due ${fmtDate(project.deadline)}` : ''}</div></div>
        <div className="row"><Link to="/databases" className="btn secondary sm"><Icon name="database" /> Databases</Link><button className="btn sm" onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))}><Icon name="search" /> Search databases</button></div>
      </div>

      <form className="panel" onSubmit={start} style={{ marginBottom: 14 }}>
        <div className="pb row wrap">
          <Icon name="dna" size={20} />
          <input className="input grow" style={{ minWidth: 240 }} placeholder="Start with a nucleotide accession (NM_000546), genomic coordinates, or paste a DNA sequence / FASTA" value={acc} onChange={(e) => setAcc(e.target.value)} aria-label="Accession or sequence" />
          <button className="btn" disabled={busy || !acc.trim()}>{busy ? 'Starting…' : 'Fetch from NCBI'}</button>
        </div>
      </form>

      <div className="panel" style={{ marginBottom: 14 }}>
        <header><h3>Research pipeline</h3><span className="muted small">DNA → Gene → Protein → Chemical → Structure → Analysis</span></header>
        <div className="pb"><div className="flow">
          {STAGES.map((s) => { const t = kindTable(s.k); return <Link key={s.k} to={t ? `/t/${t.id}` : `/kind/${s.k}`} className="stage"><div className="v">{d ? (d.recordsByKind[s.k] ?? 0).toLocaleString() : t?.recordCount ?? '–'}</div><div className="l">{s.l}</div></Link>; })}
        </div></div>
      </div>

      {err && <div className="notice err">{err}</div>}
      {!d && !err && <Spinner label="Loading project…" />}
      {d && (
        <>
          <div className="tiles" style={{ marginBottom: 14 }}>
            <div className="tile"><div className="v">{d.recordCount.toLocaleString()}</div><div className="l">Records</div></div>
            <div className="tile"><div className="v">{d.tasks.done}<span className="muted" style={{ fontSize: '1rem' }}> / {d.tasks.total}</span></div><div className="l">Tasks completed</div></div>
            <div className="tile"><div className="v" style={d.tasks.overdue ? { color: 'var(--red)' } : undefined}>{d.tasks.pending}</div><div className="l">Pending tasks{d.tasks.overdue ? ` · ${d.tasks.overdue} overdue` : ''}</div></div>
            <Link to="/jobs" className="tile"><div className="v" style={d.failedJobs ? { color: 'var(--red)' } : undefined}>{d.failedJobs}</div><div className="l">Failed jobs</div></Link>
            <Link to="/jobs" className="tile"><div className="v">{d.runningJobs}</div><div className="l">Running / queued</div></Link>
          </div>
          <div className="cols2">
            <div className="col" style={{ gap: 14 }}>
              <div className="panel"><header><h3>Progress</h3></header><div className="pb col">
                <div><div className="row between small"><span>Tasks</span><b>{d.progress.tasksPct === null ? '—' : d.progress.tasksPct + '%'}</b></div><div className="bar green"><i style={{ width: `${d.progress.tasksPct ?? 0}%` }} /></div></div>
                <div><div className="row between small"><span>Records completed (workflow status)</span><b>{d.progress.recordsPct === null ? '—' : d.progress.recordsPct + '%'}</b></div><div className="bar"><i style={{ width: `${d.progress.recordsPct ?? 0}%` }} /></div></div>
                <div className="row wrap" style={{ gap: 4 }}>{Object.entries(d.statusTotals).map(([k, v]) => <Chip key={k} color={{ Completed: 'green', Processing: 'amber', Review: 'sky', Failed: 'red' }[k] ?? 'gray'}>{k} · {v}</Chip>)}</div>
              </div></div>
              <div className="panel"><header><h3>Upcoming deadlines</h3></header><div className="pb">
                {d.deadlines.length === 0 ? <span className="muted">No open tasks with a due date.</span> : d.deadlines.map((x) => <Link key={x.id} to={`/record/${x.id}`} className="linkrow" style={{ color: 'inherit', textDecoration: 'none' }}><span className="grow">{x.title}</span><Chip color={x.due < new Date().toISOString().slice(0, 10) ? 'red' : 'gray'}>{fmtDate(x.due)}</Chip><span className="muted small">{x.status}</span></Link>)}
              </div></div>
            </div>
            <div className="col" style={{ gap: 14 }}>
              <div className="panel"><header><h3>Recent jobs</h3><Link to="/jobs" className="small" style={{ marginLeft: 'auto' }}>All jobs</Link></header><div className="pb col" style={{ gap: 6 }}>
                {jobs.length === 0 ? <span className="muted">Nothing has run yet. Fetch an accession above, or open a record and press “Run full pipeline”.</span> : jobs.map((j) => <div key={j.id} className="row"><StatusChip status={j.status} /><Link to={`/jobs/${j.id}`} className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.name}</Link><span className="muted small">{ago(j.finishedAt ?? j.createdAt)}</span></div>)}
              </div></div>
              <div className="panel"><header><h3>Recent activity</h3></header><div className="pb col" style={{ gap: 4 }}>
                {d.recent.length === 0 ? <span className="muted">No activity yet.</span> : d.recent.map((r, i) => <Link key={i} to={r.link} className="row small" style={{ color: 'inherit', textDecoration: 'none' }}><Chip color={r.kind === 'failed' ? 'red' : r.kind === 'created' ? 'green' : 'sky'}>{r.kind}</Chip><span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.text}</span><span className="muted">{ago(r.at)}</span></Link>)}
              </div></div>
            </div>
          </div>
        </>
      )}
    </div>
  );
  void navigate; void JobLine;
}
