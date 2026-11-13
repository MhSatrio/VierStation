import { useCallback, useEffect, useState } from 'react';
import { del, get, patch, post } from '../lib/api.ts';
import { Link, navigate } from '../lib/router.tsx';
import { refreshUnread, toast, useEvent, useSession } from '../lib/store.ts';
import { Chip, Empty, Modal, Spinner, StatusChip, ago, fmtDate } from './common.tsx';
import { Icon } from './icons.tsx';
import type { JobInfo } from '../../shared/types.ts';

const dur = (a: string | null, b: string | null) => { if (!a) return ''; const s = Math.round(((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };

export function JobsPage({ selected }: { selected?: string }) {
  const { wsId, projectId } = useSession((s) => ({ wsId: s.wsId, projectId: s.projectId }));
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => {
    if (!wsId) return;
    get(`/api/workspaces/${wsId}/jobs?limit=150${filter ? `&status=${filter}` : ''}${scope === 'project' && projectId ? `&project=${projectId}` : ''}`).then((r) => { setJobs(r.jobs); setCounts(r.counts); setLoaded(true); }, () => setLoaded(true));
  }, [wsId, filter, scope, projectId]);
  useEffect(load, [load]);
  useEvent('job.changed', load, [load]);
  useEffect(() => { const t = setInterval(() => jobs.some((j) => j.status === 'running') && load(), 5000); return () => clearInterval(t); }, [jobs, load]);
  return (
    <div className="page">
      <div className="row between wrap"><div><h1>Jobs</h1><p className="lead" style={{ margin: 0 }}>Everything that takes time – database fetches, discovery, analyses – runs here in the background. You can keep working; you’ll be notified when a job finishes.</p></div></div>
      <div className="row wrap" style={{ margin: '12px 0' }}>
        {['', 'queued', 'running', 'completed', 'failed', 'cancelled'].map((s) => <button key={s} className={`btn sm ${filter === s ? '' : 'secondary'}`} onClick={() => setFilter(s)}>{s ? s[0].toUpperCase() + s.slice(1) : 'All'}{s && counts[s] ? ` · ${counts[s]}` : ''}</button>)}
        <span className="grow" /><select className="select" style={{ width: 170, minHeight: 28 }} value={scope} onChange={(e) => setScope(e.target.value as 'project' | 'all')} aria-label="Scope"><option value="project">This project</option><option value="all">Whole workspace</option></select>
      </div>
      {!loaded ? <Spinner /> : jobs.length === 0 ? <Empty title="No jobs">Start a fetch from the Overview page or from any record.</Empty> : (
        <table className="t" aria-label="Jobs">
          <thead><tr><th>Task</th><th>Status</th><th>Progress</th><th className="hide-m">Started</th><th className="hide-m">Duration</th><th /></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/jobs/${j.id}`)}>
                <td><b>{j.name}</b><div className="small muted">{j.message && j.status !== 'failed' ? j.message : j.status === 'failed' ? <span style={{ color: 'var(--red)' }}>{j.error}</span> : j.type}</div></td>
                <td><StatusChip status={j.status} />{j.attempts > 1 && <span className="small muted"> · try {j.attempts}</span>}</td>
                <td style={{ minWidth: 130 }}>{j.progressTotal ? <><div className="bar"><i style={{ width: `${Math.min(100, (100 * (j.progressDone ?? 0)) / j.progressTotal)}%` }} /></div><span className="small muted">{j.progressDone}/{j.progressTotal}</span></> : j.progressDone ? <span className="small muted">{j.progressDone} processed</span> : <span className="muted small">{j.status === 'running' ? 'working…' : '—'}</span>}</td>
                <td className="hide-m small">{ago(j.startedAt ?? j.createdAt)}</td><td className="hide-m small">{dur(j.startedAt, j.finishedAt)}</td>
                <td onClick={(e) => e.stopPropagation()}><div className="row" style={{ justifyContent: 'flex-end' }}>
                  {(j.status === 'queued' || j.status === 'running') && <button className="btn ghost sm" onClick={async () => { await post(`/api/jobs/${j.id}/cancel`); load(); }}>Cancel</button>}
                  {['failed', 'cancelled'].includes(j.status) && <button className="btn secondary sm" onClick={async () => { try { await post(`/api/jobs/${j.id}/retry`); toast('Job re-queued', 'ok'); load(); } catch (e) { toast((e as Error).message, 'err'); } }}>Retry</button>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selected && <JobDetail id={selected} onClose={() => navigate('/jobs')} />}
    </div>
  );
}

function JobDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<{ job: JobInfo; logs: { ts: string; level: string; message: string }[] } | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => get(`/api/jobs/${id}`).then(setD, (e) => setErr(e.message)), [id]);
  useEffect(() => { void load(); }, [load]);
  useEvent('job.changed', (e) => { if (e.jobId === id) void load(); }, [id]);
  const j = d?.job;
  const r = j?.result as any;
  return (
    <Modal title={j ? j.name : 'Job'} size="wide" onClose={onClose} footer={j && <>{(j.status === 'queued' || j.status === 'running') && <button className="btn danger" onClick={() => post(`/api/jobs/${id}/cancel`)}>Cancel job</button>}{['failed', 'cancelled', 'completed'].includes(j.status) && <button className="btn secondary" onClick={async () => { const x = await post(`/api/jobs/${id}/retry`); navigate(`/jobs/${x.jobId}`); }}>Run again</button>}<button className="btn" onClick={onClose}>Close</button></>}>
      {err ? <div className="notice err">{err}</div> : !j ? <Spinner /> : (
        <div className="col" style={{ gap: 12 }}>
          <div className="row wrap"><StatusChip status={j.status} /><span className="muted small">Type <span className="mono">{j.type}</span> · attempt {j.attempts}/{j.maxAttempts} · created {fmtDate(j.createdAt, true)}{j.startedAt ? ` · started ${fmtDate(j.startedAt, true)}` : ''}{j.finishedAt ? ` · finished ${fmtDate(j.finishedAt, true)} (${dur(j.startedAt, j.finishedAt)})` : ''}</span></div>
          {j.progressTotal ? <div><div className="bar"><i style={{ width: `${(100 * (j.progressDone ?? 0)) / j.progressTotal}%` }} /></div><div className="small muted">{j.progressDone} of {j.progressTotal} {j.message ? `· ${j.message}` : ''}</div></div> : j.message && <div className="small">{j.message}</div>}
          {j.error && <div className="notice err">{j.error}</div>}
          {r?.summary && <div className="notice ok">{r.summary}</div>}
          {r?.notes?.length > 0 && <div className="notice warn"><b>Notes</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{r.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul></div>}
          {r?.hits && <table className="t"><thead><tr><th>Match</th><th>Identity</th><th>Coverage</th></tr></thead><tbody>{r.hits.map((h: any) => <tr key={h.accession}><td><b>{h.accession}</b><div className="small muted">{h.title}</div></td><td>{h.identityPct}%</td><td>{h.coveragePct}%</td></tr>)}</tbody></table>}
          {j.output?.kind === 'analysis' && <Link to={`/analysis/${j.output.ref}`} className="btn secondary" style={{ alignSelf: 'flex-start' }}>Open analysis result</Link>}
          {r?.recordId && <Link to={`/record/${r.recordId}`} className="btn secondary" style={{ alignSelf: 'flex-start' }}>Open record</Link>}
          <details open={j.status === 'failed'}><summary><b>Log</b> ({d!.logs.length})</summary>
            <div className="code" style={{ maxHeight: 220, marginTop: 6 }}>{d!.logs.map((l) => `${l.ts.slice(11, 19)} ${l.level === 'info' ? '   ' : l.level.toUpperCase().padEnd(5)} ${l.message}`).join('\n') || 'No log lines.'}</div></details>
          {r && <details><summary><b>Raw result</b></summary><div className="code" style={{ maxHeight: 260, marginTop: 6 }}>{JSON.stringify(r, null, 2).slice(0, 20000)}</div></details>}
        </div>
      )}
    </Modal>
  );
}

export function NotificationsPage() {
  const [items, setItems] = useState<{ id: string; kind: string; title: string; body: string; link: string | null; read: boolean; createdAt: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => get('/api/notifications').then((r) => { setItems(r.notifications); setLoaded(true); void refreshUnread(); }), []);
  useEffect(() => { void load(); }, [load]);
  useEvent('notification', () => void load());
  const user = useSession((s) => s.user);
  const kinds = useSession((s) => s.kinds);
  const [prefs, setPrefs] = useState<Record<string, { inApp: boolean; browser: boolean }>>({});
  useEffect(() => { const p = (user?.prefs as any)?.notifications ?? {}; setPrefs(Object.fromEntries(kinds.map((k) => [k.kind, { inApp: true, browser: true, ...(p[k.kind] ?? {}) }]))); }, [user, kinds]);
  const [perm, setPerm] = useState('Notification' in window ? Notification.permission : 'unsupported');
  const savePrefs = async (next: typeof prefs) => { setPrefs(next); try { await patch('/api/app/prefs', { notifications: next }); } catch (e) { toast((e as Error).message, 'err'); } };
  const icon = (k: string) => (k === 'task_failed' ? 'alert' : k === 'structure_ready' ? 'cube' : k === 'analysis_completed' ? 'chart' : k === 'deadline' ? 'clock' : k === 'collaborator_update' ? 'user' : 'download');
  return (
    <div className="page">
      <div className="row between wrap"><h1>Notifications</h1><div className="row"><button className="btn secondary sm" onClick={async () => { await post('/api/notifications/read', {}); void load(); }}>Mark all read</button><button className="btn ghost sm" onClick={async () => { await del('/api/notifications'); void load(); }}>Clear read</button></div></div>
      <div className="cols2" style={{ marginTop: 12, alignItems: 'start' }}>
        <div className="panel">
          {!loaded ? <div className="pb"><Spinner /></div> : items.length === 0 ? <Empty title="You're all caught up">Notifications appear here when fetches, structures and analyses finish, tasks fail, collaborators change your records, or deadlines approach.</Empty> : items.map((n) => (
            <div key={n.id} className="linkrow" style={{ padding: '9px 12px', borderBottom: '1px solid var(--line)', background: n.read ? undefined : 'var(--sky-soft)', alignItems: 'flex-start' }}>
              <span style={{ color: n.kind === 'task_failed' ? 'var(--red)' : 'var(--brand)', paddingTop: 2 }}><Icon name={icon(n.kind)} /></span>
              <div className="grow"><div style={{ fontWeight: n.read ? 400 : 600 }}>{n.title}</div>{n.body && <div className="small muted">{n.body}</div>}<div className="small muted">{ago(n.createdAt)}</div></div>
              {n.link && <button className="btn secondary sm" onClick={async () => { await post('/api/notifications/read', { ids: [n.id] }); if (n.link!.startsWith('/api/')) window.open(n.link!, '_blank'); else navigate(n.link!); void load(); }}>Open</button>}
              {!n.read && <button className="btn ghost sm" onClick={async () => { await post('/api/notifications/read', { ids: [n.id] }); void load(); }}>Read</button>}
            </div>
          ))}
        </div>
        <div className="panel"><header><h3>Preferences</h3></header><div className="pb col">
          <table className="t"><thead><tr><th>When…</th><th>In app</th><th>Browser</th></tr></thead><tbody>
            {kinds.map((k) => (
              <tr key={k.kind}><td>{k.label}</td>
                {(['inApp', 'browser'] as const).map((ch) => <td key={ch}><input type="checkbox" checked={!!prefs[k.kind]?.[ch]} onChange={(e) => savePrefs({ ...prefs, [k.kind]: { ...prefs[k.kind], [ch]: e.target.checked } })} aria-label={`${k.label}: ${ch}`} /></td>)}
              </tr>
            ))}
          </tbody></table>
          {perm === 'default' && <div className="notice"><button className="btn sm" onClick={async () => { setPerm(await Notification.requestPermission()); }}>Enable browser notifications</button> <span className="small">Shown only while this tab is in the background.</span></div>}
          {perm === 'denied' && <div className="notice warn small">Browser notifications are blocked for this site; allow them in your browser settings.</div>}
          {perm === 'granted' && <div className="small muted">Browser notifications are enabled.</div>}
        </div></div>
      </div>
    </div>
  );
  void Chip;
}
