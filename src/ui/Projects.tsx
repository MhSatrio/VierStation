import { useEffect, useState } from 'react';
import { del, get, patch, post } from '../lib/api.ts';
import { Link, navigate, useQueryParam } from '../lib/router.tsx';
import { refreshWorkspace, session, toast, useSession } from '../lib/store.ts';
import { Chip, Empty, Modal, confirmDialog, fmtDate } from './common.tsx';
import { KIND_ICON, Icon } from './icons.tsx';

interface Tpl { id: string; name: string; description: string; tables: string[] }

export function Projects() {
  const { wsId, projects, projectId, tables } = useSession((s) => ({ wsId: s.wsId, projects: s.projects, projectId: s.projectId, tables: s.tables }));
  const [creating, setCreating] = useState(useQueryParam('new') === '1');
  const [edit, setEdit] = useState<(typeof projects)[number] | null>(null);
  return (
    <div className="page">
      <div className="row between wrap" style={{ marginBottom: 12 }}><div><h1>Projects</h1><p className="lead" style={{ margin: 0 }}>A project groups the tables, tasks, automations and analyses of one piece of research.</p></div><button className="btn" onClick={() => setCreating(true)}><Icon name="plus" /> New project</button></div>
      {projects.length === 0 ? <Empty title="No projects yet">Create one from a scientific template.</Empty> : (
        <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))' }}>
          {projects.map((p) => {
            const ts = tables.filter((t) => t.projectId === p.id);
            return (
              <div key={p.id} className="tile col" style={{ gap: 8, ...(p.id === projectId ? { borderColor: 'var(--brand)' } : {}) }}>
                <div className="row between"><b style={{ fontSize: '1.05rem' }}>{p.name}</b>{p.visibility === 'private' && <Chip color="gray">private</Chip>}</div>
                <div className="muted small" style={{ minHeight: 34 }}>{p.description || 'No description'}</div>
                <div className="row wrap" style={{ gap: 4 }}>{ts.slice(0, 8).map((t) => <Chip key={t.id} color="sky"><Icon name={KIND_ICON[t.kind] ?? 'grid'} size={11} /> {t.name} · {t.recordCount ?? 0}</Chip>)}</div>
                {p.deadline && <div className="small muted">Due {fmtDate(p.deadline)}</div>}
                <div className="row"><button className="btn sm" onClick={() => { session.set({ projectId: p.id }); void patch('/api/app/prefs', { activeProject: p.id }); navigate('/'); }}>{p.id === projectId ? 'Open overview' : 'Open'}</button>{p.level === 'admin' && <button className="btn ghost sm" onClick={() => setEdit(p)}>Settings</button>}</div>
              </div>
            );
          })}
        </div>
      )}
      {creating && wsId && <NewProject wsId={wsId} onClose={() => setCreating(false)} />}
      {edit && <ProjectSettings p={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function NewProject({ wsId, onClose }: { wsId: string; onClose: () => void }) {
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [tpl, setTpl] = useState('discovery');
  const [name, setName] = useState(''); const [desc, setDesc] = useState(''); const [priv, setPriv] = useState(false); const [due, setDue] = useState(''); const [autos, setAutos] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/api/templates').then((r) => setTpls([{ id: 'blank', name: 'Blank project', description: 'Just the tasks table; add your own databases.', tables: ['task'] }, ...r.templates]), () => {}); }, []);
  const go = async () => {
    setBusy(true);
    try {
      const r = await post(`/api/workspaces/${wsId}/projects`, { name, description: desc, template: tpl === 'blank' ? 'project-tracker' : tpl, visibility: priv ? 'private' : 'workspace', deadline: due || null, automations: autos });
      await refreshWorkspace(r.id); session.set({ projectId: r.id }); await patch('/api/app/prefs', { activeProject: r.id });
      toast('Project created', 'ok'); onClose(); navigate('/');
    } catch (e) { toast((e as Error).message, 'err'); setBusy(false); }
  };
  return (
    <Modal title="New project" size="wide" onClose={onClose} footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={!name.trim() || busy} onClick={go}>{busy ? 'Creating…' : 'Create project'}</button></>}>
      <div className="col">
        <div className="row wrap"><label className="field grow">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label><label className="field">Due date<input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label></div>
        <label className="field">Description<input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} /></label>
        <b className="small">Start from a scientific template</b>
        <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {tpls.map((t) => <button key={t.id} className="tile" style={tpl === t.id ? { borderColor: 'var(--brand)', background: 'var(--sky-soft)' } : undefined} onClick={() => setTpl(t.id)}><b>{t.name}</b><div className="small muted" style={{ margin: '3px 0' }}>{t.description}</div><div className="row wrap" style={{ gap: 3 }}>{t.tables.map((k) => <Icon key={k} name={KIND_ICON[k] ?? 'grid'} size={13} />)}</div></button>)}
        </div>
        <label className="check"><input type="checkbox" checked={autos} onChange={(e) => setAutos(e.target.checked)} /> Add the template's automation rules (created switched off – you enable the ones you want)</label>
        <label className="check"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private project (only people you add can see it)</label>
      </div>
    </Modal>
  );
}

function ProjectSettings({ p, onClose }: { p: { id: string; name: string; description: string; visibility: string; deadline: string | null; status: string }; onClose: () => void }) {
  const [name, setName] = useState(p.name); const [desc, setDesc] = useState(p.description); const [vis, setVis] = useState(p.visibility); const [due, setDue] = useState(p.deadline ?? ''); const [status, setStatus] = useState(p.status);
  const [members, setMembers] = useState<{ id: string; name: string; email: string; role: string }[]>([]);
  const [all, setAll] = useState<{ id: string; name: string; email: string }[]>([]);
  const wsId = useSession((s) => s.wsId);
  const load = () => get(`/api/projects/${p.id}/members`).then((r) => setMembers(r.members));
  useEffect(() => { void load(); if (wsId) get(`/api/workspaces/${wsId}/members`).then((r) => setAll(r.members)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => { try { await patch(`/api/projects/${p.id}`, { name, description: desc, visibility: vis, deadline: due || null, status }); await refreshWorkspace(); toast('Saved', 'ok'); onClose(); } catch (e) { toast((e as Error).message, 'err'); } };
  return (
    <Modal title={`Project settings · ${p.name}`} onClose={onClose} footer={<><button className="btn danger" style={{ marginRight: 'auto' }} onClick={async () => { if (await confirmDialog(`Delete the project “${p.name}” with ALL its tables, records, automations and analyses? This cannot be undone.`, 'Delete project')) { await del(`/api/projects/${p.id}`); await refreshWorkspace(); onClose(); } }}>Delete project</button><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={save}>Save</button></>}>
      <div className="col">
        <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Description<input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
        <div className="row wrap"><label className="field">Due date<input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label><label className="field">Status<select className="select" value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option><option value="archived">Archived</option></select></label>
          <label className="field">Access<select className="select" value={vis} onChange={(e) => setVis(e.target.value)}><option value="workspace">Everyone in the workspace</option><option value="private">Only people added below</option></select></label></div>
        <b className="small">Project access</b>
        {members.map((m) => <div key={m.id} className="row"><span className="grow">{m.name} <span className="muted small">{m.email}</span></span><select className="select" style={{ width: 110 }} value={m.role} onChange={async (e) => { await fetch(`/api/projects/${p.id}/members/${m.id}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-vs': '1' }, body: JSON.stringify({ role: e.target.value }) }); void load(); }} aria-label={`Role of ${m.name}`}><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button className="btn ghost sm" onClick={async () => { await del(`/api/projects/${p.id}/members/${m.id}`); void load(); }}>Remove</button></div>)}
        <select className="select" value="" onChange={async (e) => { if (!e.target.value) return; await fetch(`/api/projects/${p.id}/members/${e.target.value}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-vs': '1' }, body: JSON.stringify({ role: 'editor' }) }); void load(); }} aria-label="Add person"><option value="">+ Add a workspace member…</option>{all.filter((a) => !members.some((m) => m.id === a.id)).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.email})</option>)}</select>
        <span className="muted small">Workspace owners and admins can always open every project. Add people to the workspace in Settings → Members first.</span>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Databases
export function Databases() {
  const { projectId, tables, projects } = useSession((s) => ({ projectId: s.projectId, tables: s.tables, projects: s.projects }));
  const mine = tables.filter((t) => t.projectId === projectId);
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [busy, setBusy] = useState('');
  const [name, setName] = useState('');
  const project = projects.find((p) => p.id === projectId);
  useEffect(() => { get('/api/templates').then((r) => setTpls(r.templates), () => {}); }, []);
  if (!project) return <div className="page"><Empty title="No project selected">Create a project first.</Empty></div>;
  const editor = project.level !== 'viewer';
  return (
    <div className="page">
      <h1>Databases</h1>
      <p className="lead">Every table in <b>{project.name}</b>. Tables are linked to one another with real relationships, so a protein knows its gene, its chemicals and its structures.</p>
      <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', marginBottom: 20 }}>
        {mine.map((t) => <Link key={t.id} to={`/t/${t.id}`} className="tile" style={{ textDecoration: 'none' }}><div className="row"><span style={{ color: 'var(--brand)' }}><Icon name={KIND_ICON[t.kind] ?? 'grid'} size={20} /></span><b>{t.name}</b><span className="grow" /><span className="v" style={{ fontSize: '1.1rem' }}>{(t.recordCount ?? 0).toLocaleString()}</span></div><div className="muted small" style={{ marginTop: 4 }}>{t.description || 'Custom table'}</div></Link>)}
      </div>
      {editor && (
        <>
          <div className="row between wrap"><h2>Add a table or a ready-made database</h2></div>
          <div className="row" style={{ margin: '8px 0 14px' }}><input className="input" style={{ maxWidth: 320 }} placeholder="New blank table name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New table name" /><button className="btn secondary" disabled={!name.trim()} onClick={async () => { try { const r = await post(`/api/projects/${projectId}/tables`, { name }); const { refreshTables } = await import('../lib/store.ts'); await refreshTables(); navigate(`/t/${r.table.id}`); } catch (e) { toast((e as Error).message, 'err'); } }}><Icon name="plus" /> Create table</button></div>
          <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {tpls.map((t) => <div key={t.id} className="tile"><b>{t.name}</b><div className="small muted" style={{ margin: '3px 0 8px' }}>{t.description}</div><div className="row wrap" style={{ gap: 3, marginBottom: 8 }}>{t.tables.map((k) => <Chip key={k} color="sky">{k}</Chip>)}</div><button className="btn secondary sm" disabled={!!busy} onClick={async () => { setBusy(t.id); try { await post(`/api/projects/${projectId}/templates/${t.id}`, { automations: true }); const { refreshTables } = await import('../lib/store.ts'); await refreshTables(); toast(`${t.name} added`, 'ok'); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(''); } }}>{busy === t.id ? 'Adding…' : 'Add to project'}</button></div>)}
          </div>
        </>
      )}
    </div>
  );
}
