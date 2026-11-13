import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { patch, post } from '../lib/api.ts';
import { Link, navigate, useLocation } from '../lib/router.tsx';
import { refreshTables, refreshUnread, refreshWorkspace, session, toast, useEvent, useSession } from '../lib/store.ts';
import { GlobalOverlays, MenuButton, initials } from './common.tsx';
import { Icon } from './icons.tsx';
import { SearchModal } from './SearchModal.tsx';
import { get } from '../lib/api.ts';
import { APP_VERSION } from '../../shared/app.ts';

const KIND_NAV = [
  { kind: 'dna', label: 'DNA Sequences', icon: 'dna' }, { kind: 'gene', label: 'Genes', icon: 'gene' }, { kind: 'protein', label: 'Proteins', icon: 'protein' },
  { kind: 'chemical', label: 'Chemicals', icon: 'flask' }, { kind: 'structure', label: 'Structures', icon: 'cube' },
  { kind: 'reaction', label: 'Reactions', icon: 'reaction', optional: true }, { kind: 'pathway', label: 'Pathways', icon: 'pathway', optional: true },
];

function NetworkChip() {
  const n = useSession((x) => x.network);
  const label = n.mode === 'offline' ? 'Working offline' : n.offline ? 'Offline' : 'Online';
  return (
    <Link to="/settings?tab=network" className={`netchip${n.offline ? ' off' : ''}`} title={n.offline ? `${label}: saved data is available; fetching new data waits for a connection${n.waitingJobs ? ` (${n.waitingJobs} waiting)` : ''}` : 'Online: scientific databases can be reached'} aria-label={`Network: ${label}${n.waitingJobs && n.offline ? `, ${n.waitingJobs} task(s) waiting` : ''}`}>
      <i aria-hidden="true" />{label}{n.offline && n.waitingJobs > 0 ? ` · ${n.waitingJobs} waiting` : ''}
    </Link>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const s = useSession((x) => ({ user: x.user, collapsed: x.sidebarCollapsed, projectId: x.projectId, projects: x.projects, tables: x.tables, unread: x.unread, wsId: x.wsId, workspaces: x.workspaces }));
  const { path } = useLocation();
  const [mopen, setMopen] = useState(false);
  const [search, setSearch] = useState(false);
  const [running, setRunning] = useState(0);
  useEffect(() => setMopen(false), [path]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearch(true); } else if (e.key === '/' && !/input|textarea|select/i.test((e.target as HTMLElement).tagName) && !(e.target as HTMLElement).isContentEditable) { e.preventDefault(); setSearch(true); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const loadRunning = () => { if (s.wsId) get(`/api/workspaces/${s.wsId}/jobs?limit=1`).then((r) => setRunning((r.counts.running ?? 0) + (r.counts.queued ?? 0)), () => {}); };
  useEffect(loadRunning, [s.wsId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvent('job.changed', loadRunning, [s.wsId]);
  const countsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEvent('record.changed', () => { if (countsTimer.current) clearTimeout(countsTimer.current); countsTimer.current = setTimeout(() => void refreshTables(), 1200); });
  useEvent('schema.changed', () => void refreshTables());
  useEvent('notification', (n) => {
    void refreshUnread();
    toast(n.title, n.kind === 'task_failed' ? 'err' : 'ok', n.link ? { to: n.link, label: 'Open' } : undefined);
    if (n.browser && 'Notification' in window && Notification.permission === 'granted' && document.hidden) { try { new Notification(n.title, { body: n.body, icon: '/brand/icon-512.png' }); } catch { /* not allowed */ } }
  });
  const project = s.projects.find((p) => p.id === s.projectId);
  const kindTable = (k: string) => s.tables.find((t) => t.projectId === s.projectId && t.kind === k);
  const active = (p: string, exact = false) => (exact ? path === p : path === p || path.startsWith(p + '/'));
  const toggleCollapse = () => { session.set({ sidebarCollapsed: !s.collapsed }); void patch('/api/app/prefs', { sidebarCollapsed: !s.collapsed }); };
  const tablePathActive = (k: string) => { const t = kindTable(k); return !!t && (path === `/t/${t.id}` || path === `/kind/${k}`); };

  return (
    <div className={`shell${s.collapsed ? ' collapsed' : ''}${mopen ? ' mopen' : ''}`}>
      <a href="#main" className="sr-only">Skip to content</a>
      <aside className="sidebar">
        <div className="brand">
          <img className="mark" src="/brand/icon.svg" alt="" /><span className="name">Vier<b>Station</b></span>
        </div>
        <nav className="nav" aria-label="Main navigation">
          <Link to="/" className={active('/', true) ? 'active' : ''} aria-current={active('/', true) ? 'page' : undefined} title="Overview"><Icon name="home" size={18} /><span className="label">Overview</span></Link>
          <Link to="/projects" className={active('/projects') ? 'active' : ''} title="Projects"><Icon name="folder" size={18} /><span className="label">Projects</span><span className="count">{s.projects.length}</span></Link>
          <Link to="/databases" className={active('/databases') ? 'active' : ''} title="Databases"><Icon name="database" size={18} /><span className="label">Databases</span></Link>
          <div className="group">Research data</div>
          {KIND_NAV.map((k) => {
            const t = kindTable(k.kind); if ((k as { optional?: boolean }).optional && !t) return null;
            return <Link key={k.kind} to={`/kind/${k.kind}`} className={tablePathActive(k.kind) ? 'active' : ''} title={k.label}><Icon name={k.icon} size={18} /><span className="label">{k.label}</span>{t && <span className="count">{t.recordCount ?? 0}</span>}</Link>;
          })}
          <div className="group">Work</div>
          <Link to="/analysis" className={active('/analysis') ? 'active' : ''} title="Analysis"><Icon name="chart" size={18} /><span className="label">Analysis</span></Link>
          <Link to="/lab" className={active('/lab') ? 'active' : ''} title="Sequence Lab"><Icon name="dna" size={18} /><span className="label">Sequence Lab</span></Link>
          <Link to="/explorer" className={active('/explorer') ? 'active' : ''} title="Relationship explorer"><Icon name="graph" size={18} /><span className="label">Explorer</span></Link>
          <Link to="/map" className={active('/map') ? 'active' : ''} title="Sample map"><Icon name="globe" size={18} /><span className="label">Sample map</span></Link>
          <Link to="/automations" className={active('/automations') ? 'active' : ''} title="Automations"><Icon name="bolt" size={18} /><span className="label">Automations</span></Link>
          <Link to="/jobs" className={active('/jobs') ? 'active' : ''} title="Jobs"><Icon name="play" size={18} /><span className="label">Jobs</span>{running > 0 && <span className="count" style={{ background: 'var(--amber-bg)', color: 'var(--amber)' }}>{running}</span>}</Link>
          <Link to="/notifications" className={active('/notifications') ? 'active' : ''} title="Notifications"><Icon name="bell" size={18} /><span className="label">Notifications</span>{s.unread > 0 && <span className="count" style={{ background: 'var(--red)', color: '#fff' }}>{s.unread}</span>}</Link>
          <Link to="/settings" className={active('/settings') ? 'active' : ''} title="Settings"><Icon name="cog" size={18} /><span className="label">Settings</span></Link>
        </nav>
        <div className="foot">
          <button className="btn ghost icon sm hide-m" onClick={toggleCollapse} aria-label={s.collapsed ? 'Expand navigation' : 'Collapse navigation'} title={s.collapsed ? 'Expand navigation' : 'Collapse navigation'}><Icon name="sidebar" /></button>
          <span className="muted small label" style={{ marginLeft: 'auto' }}>v{APP_VERSION} · VierApparatus</span>
        </div>
      </aside>
      <div className="main">
        <header className="header">
          <button className="btn ghost icon show-m" onClick={() => setMopen(true)} aria-label="Open navigation"><Icon name="menu" /></button>
          <div className="crumbs">
            <MenuButton className="btn ghost sm" label={<><Icon name="folder" /> {project?.name ?? 'No project'} <Icon name="chevD" size={12} /></>} title="Switch project">
              {(close) => (<>
                {s.projects.map((p) => <button key={p.id} className={`item${p.id === s.projectId ? ' sel' : ''}`} onClick={() => { session.set({ projectId: p.id }); void patch('/api/app/prefs', { activeProject: p.id }); close(); if (path.startsWith('/t/') || path.startsWith('/kind/')) navigate('/'); }}>{p.name}{p.visibility === 'private' && <span className="badge">private</span>}</button>)}
                <hr /><button className="item" onClick={() => { close(); navigate('/projects?new=1'); }}><Icon name="plus" /> New project</button>
              </>)}
            </MenuButton>
          </div>
          <span className="grow" />
          <button className="searchbox" onClick={() => setSearch(true)} aria-label="Search records and scientific databases (Ctrl+K)"><Icon name="search" size={15} /><span className="t">Search records & databases</span><kbd>Ctrl K</kbd></button>
          <Link to="/jobs" className="btn ghost icon" title={running ? `${running} job(s) running` : 'Jobs'} aria-label="Jobs">{running > 0 ? <span className="spinner" /> : <Icon name="play" />}</Link>
          <Link to="/notifications" className="btn ghost icon bell" aria-label={`Notifications${s.unread ? `, ${s.unread} unread` : ''}`}><Icon name="bell" />{s.unread > 0 && <span className="dot">{s.unread > 9 ? '9+' : s.unread}</span>}</Link>
          <NetworkChip />
          <MenuButton className="btn ghost icon" label={<span className="avatar" aria-hidden="true"><Icon name="database" size={15} /></span>} align="right" title="Workspace">
            {(close) => (<div style={{ minWidth: 220 }}>
              <div style={{ padding: '6px 8px' }}><b>{s.workspaces.find((w) => w.id === s.wsId)?.name ?? 'Workspace'}</b><div className="muted small">Local workspace · your data stays on this computer</div></div><hr />
              {s.workspaces.length > 1 && s.workspaces.map((w) => <button key={w.id} className={`item${w.id === s.wsId ? ' sel' : ''}`} onClick={async () => { session.set({ wsId: w.id, projectId: null }); await patch('/api/app/prefs', { activeWorkspace: w.id }); close(); await refreshWorkspace(); navigate('/'); }}>{w.name}</button>)}
              <button className="item" onClick={() => { close(); navigate('/settings'); }}><Icon name="cog" /> Settings</button>
            </div>)}
          </MenuButton>
        </header>
        <main className="content" id="main" tabIndex={-1}>{children}</main>
      </div>
      {mopen && <div onClick={() => setMopen(false)} style={{ position: 'fixed', inset: 0, background: 'rgb(35 31 32 / .35)', zIndex: 54 }} aria-hidden="true" />}
      {search && <SearchModal onClose={() => setSearch(false)} />}
      <GlobalOverlays />
    </div>
  );
}

