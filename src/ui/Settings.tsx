// Settings for a local, offline-first scientific application: appearance, network, local data (backup / restore / export / import), databases and keys, activity log, about.
// There are no accounts, no passwords, no members and no e-mail settings.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, del, get, patch, post, put } from '../lib/api.ts';
import { applyTheme, loadMe, refreshWorkspace, session, toast, useSession } from '../lib/store.ts';
import { Terms } from './Setup.tsx';
import { useQueryParam, setQuery } from '../lib/router.tsx';
import { Chip, Spinner, ago, confirmDialog } from './common.tsx';
import { Lbl } from './Tip.tsx';

type Tab = 'general' | 'network' | 'data' | 'databases' | 'notifications' | 'activity' | 'about';
const TABS: [Tab, string][] = [['general', 'Appearance & defaults'], ['network', 'Network & offline'], ['data', 'Local data & backups'], ['databases', 'Databases & keys'], ['notifications', 'Notifications'], ['activity', 'Activity log'], ['about', 'About']];
const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

export function Settings() {
  const { wsId, workspaces } = useSession((s) => ({ wsId: s.wsId, workspaces: s.workspaces }));
  const ws = workspaces.find((w) => w.id === wsId);
  const setup = useSession((s) => s.setup);
  const tab = (useQueryParam('tab') as Tab | null) ?? 'general';
  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="lead">{setup?.labName ?? ws?.name} · a local workspace – your data stays on this computer. There is no account or login.</p>
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setQuery('tab', k, false)}>{l}</button>)}
      </div>
      {tab === 'general' && <General />}
      {tab === 'network' && <Network />}
      {tab === 'data' && <LocalData />}
      {tab === 'databases' && wsId && <Databases wsId={wsId} />}
      {tab === 'notifications' && <NotificationHint />}
      {tab === 'activity' && wsId && <Audit wsId={wsId} />}
      {tab === 'about' && <About />}
    </div>
  );
}

/** Lab name and data folder. The name applies at once; a new data folder applies after a restart. */
function LabStorage() {
  const setup = useSession((s) => s.setup);
  const wsId = useSession((s) => s.wsId);
  const wsName = useSession((s) => s.workspaces.find((w) => w.id === s.wsId)?.name ?? '');
  const [name, setName] = useState(setup?.labName ?? wsName);
  const [dir, setDir] = useState(setup?.dataDirConfigured ?? setup?.dataDir ?? '');
  const saveName = async () => { try { await put('/api/app/setup', { labName: name, workspaceId: wsId }); await loadMe(); toast('Lab name saved', 'ok'); } catch (e) { toast((e as Error).message, 'err'); } };
  const saveDir = async () => { try { const r = await put('/api/app/setup', { dataDir: dir }); await loadMe(); toast(r.restartRequired ? 'Saved. Restart VierStation to use the new data folder.' : 'Data folder unchanged', r.restartRequired ? 'info' : 'ok'); } catch (e) { toast((e as Error).message, 'err'); } };
  return (
    <div className="pb col">
      <label className="field">Lab name <span className="muted small">(shown in the header and on exports)</span>
        <div className="row"><input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Lab name" /><button className="btn" disabled={!name.trim()} onClick={() => void saveName()}>Save</button></div></label>
      <label className="field">Data folder <span className="muted small">(where the database and files are stored; applied after a restart)</span>
        <div className="row"><input className="input" value={dir} onChange={(e) => setDir(e.target.value)} aria-label="Data folder" /><button className="btn secondary" onClick={() => void saveDir()}>Save</button></div>
        <span className="small muted">Currently in use: <code>{setup?.dataDir ?? '…'}</code>. Move existing data yourself by copying that folder, or export a workspace (.vsws) and import it into the new one.</span></label>
    </div>
  );
}

function General() {
  const prefs = useSession((s) => s.user?.prefs ?? {}) as Record<string, any>;
  const [theme, setTheme] = useState<string>(prefs.theme ?? 'system');
  const d = prefs.defaults ?? {};
  const [def, setDef] = useState({ blastDb: d.blastDb ?? 'core_nt', blastProgram: d.blastProgram ?? 'megablast', bootstrap: d.bootstrap ?? 200, correlation: d.correlation ?? 'pearson' });
  const save = async (p: Record<string, unknown>) => { try { const r = await patch('/api/app/prefs', p); session.set((s) => ({ user: s.user ? { ...s.user, prefs: r.prefs } : s.user })); toast('Saved', 'ok'); } catch (e) { toast((e as Error).message, 'err'); } };
  return (
    <div className="col" style={{ maxWidth: 640 }}>
      <div className="panel"><header><h3>Lab and storage</h3></header><LabStorage /></div>
      <div className="panel"><header><h3>Appearance</h3></header><div className="pb col">
        <label className="field">Theme<select className="select" value={theme} onChange={(e) => { setTheme(e.target.value); applyTheme(e.target.value as 'light'); void save({ theme: e.target.value }); }}><option value="system">Follow my computer</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label className="check"><input type="checkbox" defaultChecked={prefs.tooltips !== false} onChange={(e) => void save({ tooltips: e.target.checked })} /> <Lbl k="tooltipsPref">Show explanations (tooltips) on hover, keyboard focus and touch</Lbl></label>
        <label className="check"><input type="checkbox" defaultChecked={!!prefs.reduceMotion} onChange={(e) => void save({ reduceMotion: e.target.checked })} /> Reduce motion (no graph animations)</label>
      </div></div>
      <div className="panel"><header><h3>Default analysis parameters</h3></header><div className="pb col">
        <div className="formgrid">
          <label className="field">BLAST database<select className="select" value={def.blastDb} onChange={(e) => setDef({ ...def, blastDb: e.target.value })}><option value="core_nt">core_nt</option><option value="nt">nt</option><option value="refseq_rna">refseq_rna</option></select></label>
          <label className="field">BLAST program<select className="select" value={def.blastProgram} onChange={(e) => setDef({ ...def, blastProgram: e.target.value })}><option value="megablast">Megablast (highly similar)</option><option value="blastn">blastn (more sensitive)</option></select></label>
          <label className="field">Tree bootstrap replicates<input className="input" type="number" min={0} max={1000} value={def.bootstrap} onChange={(e) => setDef({ ...def, bootstrap: Number(e.target.value) })} /></label>
          <label className="field">Correlation method<select className="select" value={def.correlation} onChange={(e) => setDef({ ...def, correlation: e.target.value })}><option value="pearson">Pearson</option><option value="spearman">Spearman</option></select></label>
        </div>
        <div><button className="btn" onClick={() => void save({ defaults: def })}>Save defaults</button></div>
      </div></div>
    </div>
  );
}

function Network() {
  const n = useSession((s) => s.network);
  const [busy, setBusy] = useState(false);
  const set = async (b: Record<string, unknown>) => { setBusy(true); try { const r = await post('/api/network', b); session.set({ network: r }); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); } };
  return (
    <div className="col" style={{ maxWidth: 720 }}>
      <div className="panel"><header><h3>Connection</h3>{n.offline ? <Chip color="amber">{n.mode === 'offline' ? 'working offline (your choice)' : 'no connection'}</Chip> : <Chip color="green">online</Chip>}</header><div className="pb col">
        <div>VierStation <b>always works from its local database</b>. The internet is only used to fetch or refresh scientific data (NCBI, UniProt, AlphaFold, PubChem, ChEMBL, BindingDB, RCSB PDB, InterPro, OpenStreetMap).</div>
        <label className="check"><input type="checkbox" checked={n.mode === 'offline'} disabled={busy} onChange={(e) => void set({ mode: e.target.checked ? 'offline' : 'auto' })} /> <Lbl k="workOffline">Work offline (never contact any database)</Lbl></label>
        <div className="row wrap"><button className="btn secondary" disabled={busy || n.mode === 'offline'} onClick={() => void set({ check: true })}>Check the connection now</button><span className="small muted">{n.checkedAt ? `last checked ${ago(n.checkedAt)}` : 'not checked yet'}</span></div>
      </div></div>
      <div className="panel"><header><h3>What works offline</h3></header><div className="pb"><table className="t"><tbody>
        <tr><td><b>Always</b></td><td>Open projects, browse every saved record, saved sequences, previously fetched NCBI information, cached protein and chemical relationships, saved structures and images, the relationship explorer, the sample map, local analyses (statistics, alignment, trees), editing records and relationships, exports and reports.</td></tr>
        <tr><td><b>Needs internet</b></td><td>Fetching new NCBI records, UniProt searches, AlphaFold/PDB structures, PubChem/ChEMBL/BindingDB data, BLAST, species lookups, place-name lookups, refreshing cached data.</td></tr>
        <tr><td><b>If you ask while offline</b></td><td>The task is <b>queued</b> (“Waiting for an internet connection”) and starts by itself when the connection is back{n.waitingJobs ? <> – <b>{n.waitingJobs}</b> waiting now</> : ''}. Answers that were fetched earlier are still served from the local cache, even when they are old.</td></tr>
      </tbody></table></div></div>
    </div>
  );
}

function LocalData() {
  const [info, setInfo] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(() => get('/api/local/info').then(setInfo), []);
  useEffect(() => { void load(); }, [load]);
  const run = async (what: string, fn: () => Promise<unknown>, okMsg: string) => { setBusy(what); try { await fn(); toast(okMsg, 'ok'); await load(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(''); } };
  if (!info) return <Spinner />;
  const b = info.bytes;
  return (
    <div className="col" style={{ maxWidth: 820 }}>
      <div className="panel"><header><h3>Where your data lives</h3></header><div className="pb col">
        <div className="small"><code>{info.dataDir}</code></div>
        <table className="t"><tbody>
          <tr><td>Database ({info.records.toLocaleString()} records, {info.relationships.toLocaleString()} relationships)</td><td>{mb(b.database)}</td></tr>
          <tr><td>Uploaded files</td><td>{mb(b.files)}</td></tr>
          <tr><td>Images and structure thumbnails (cached)</td><td>{mb(b.images)} <button className="btn ghost sm" onClick={async () => { if (await confirmDialog('Delete all cached images? They are fetched again when needed and online.', 'Clear', true)) void run('img', () => post('/api/local/cache/clear', { what: 'images' }), 'Image cache cleared'); }}>Clear</button></td></tr>
          <tr><td>Downloaded structures</td><td>{mb(b.structures)}</td></tr>
          <tr><td>Saved answers from scientific databases ({info.responseCache.entries.toLocaleString()} entries)</td><td>{mb(b.responseCache)} <button className="btn ghost sm" onClick={async () => { if (await confirmDialog('Forget saved database answers? Offline you will no longer see information that was only in this cache.', 'Clear', true)) void run('resp', () => post('/api/local/cache/clear', { what: 'responses' }), 'Saved answers cleared'); }}>Clear</button></td></tr>
          <tr><td>Backups</td><td>{mb(b.backups)}</td></tr>
        </tbody></table>
        <div className="small muted">The storage folder is chosen when VierStation starts (setting <code>VIERSTATION_DATA_DIR</code>); moving it means copying this folder or using Export/Import below. Changes are saved automatically as you make them.</div>
      </div></div>
      <div className="panel"><header><h3>Backups</h3><button className="btn" disabled={!!busy} onClick={() => void run('bk', () => post('/api/local/backups'), 'Backup created')}>{busy === 'bk' ? 'Working…' : 'Back up now'}</button></header><div className="pb">
        {info.backups.length === 0 ? <div className="muted">No backups yet.</div> : <table className="t"><thead><tr><th>Backup</th><th>Size</th><th /></tr></thead><tbody>{info.backups.map((x: any) => (
          <tr key={x.name}><td>{x.name}<div className="small muted">{ago(x.createdAt)} · {x.label}</div></td><td>{mb(x.bytes)}</td><td style={{ textAlign: 'right' }}>
            <a className="btn ghost sm" href={`/api/local/backups/${x.name}/download`}>Download</a>
            <button className="btn secondary sm" disabled={!!busy} onClick={async () => { if (await confirmDialog(`Restore “${x.name}”? Your current data is backed up first, then replaced by this backup.`, 'Restore', true)) void run('rs', async () => { await post('/api/local/restore', { name: x.name }); await refreshWorkspace(); location.reload(); }, 'Restored'); }}>Restore</button>
            <button className="btn ghost sm" disabled={!!busy} onClick={() => void run('del', () => del(`/api/local/backups/${x.name}`), 'Backup deleted')}>Delete</button></td></tr>))}</tbody></table>}
      </div></div>
      <div className="panel"><header><h3>Export / import a whole workspace</h3></header><div className="pb col">
        <div className="small">One <b>.vsws</b> file with the database (records, relationships, reactions, pathways, citations, analysis history), uploaded files, cached images and structures. Import it into another VierStation installation to continue your work there. Importing replaces the data on that computer (a safety backup is made first).</div>
        <div className="row wrap"><a className="btn" href="/api/local/export">Export workspace (.vsws)</a>
          <button className="btn secondary" disabled={!!busy} onClick={() => file.current?.click()}>{busy === 'imp' ? 'Importing…' : 'Import a .vsws file…'}</button>
          <input ref={file} type="file" accept=".vsws" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; if (!(await confirmDialog(`Import “${f.name}”? It replaces the data in this VierStation (a safety backup is made first).`, 'Import', true))) return; void run('imp', async () => { await api('POST', '/api/local/import', undefined, { raw: f }); location.reload(); }, 'Imported'); }} /></div>
      </div></div>
    </div>
  );
}

function Databases({ wsId }: { wsId: string }) {
  const [d, setD] = useState<{ secrets: { name: string; set: boolean; masked: string }[]; server: { ncbi: boolean } } | null>(null);
  const [key, setKey] = useState('');
  const [mail, setMail] = useState('');
  const load = useCallback(() => get(`/api/workspaces/${wsId}/secrets`).then(setD), [wsId]);
  useEffect(() => { void load(); get('/api/local/settings').then((s) => setMail(s.contactEmail ?? ''), () => {}); }, [load]);
  if (!d) return <Spinner />;
  const s = d.secrets.find((x) => x.name === 'ncbi_api_key');
  return (
    <div className="col" style={{ maxWidth: 720 }}>
      <div className="notice">Keys are encrypted on this computer and used only by the local server – they are never shown again or sent to the browser.</div>
      <div className="panel"><header><h3>NCBI contact e-mail</h3></header><div className="pb col"><span className="muted small">NCBI and OpenStreetMap ask to be able to contact whoever uses their services. This address is sent in the User-Agent of outgoing requests – nowhere else. VierStation never sends e-mail.</span>
        <div className="row"><input className="input" type="email" value={mail} placeholder="you@example.org" onChange={(e) => setMail(e.target.value)} aria-label="Contact e-mail" /><button className="btn" onClick={async () => { try { await put('/api/local/settings', { contactEmail: mail }); toast('Saved', 'ok'); } catch (e) { toast((e as Error).message, 'err'); } }}>Save</button></div></div></div>
      <div className="panel"><header><h3>NCBI API key (optional)</h3>{s?.set ? <Chip color="green">set · {s.masked}</Chip> : <Chip>not set</Chip>}</header><div className="pb col">
        <span className="muted small">Raises the NCBI limit from 3 to 10 requests per second. Free from your NCBI account.</span>
        <div className="row"><input className="input" type="password" autoComplete="off" placeholder={s?.set ? 'Enter a new key to replace' : 'Paste key'} value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="btn" disabled={key.length < 8} onClick={async () => { try { await put(`/api/workspaces/${wsId}/secrets/ncbi_api_key`, { value: key }); setKey(''); toast('Key saved', 'ok'); void load(); } catch (e) { toast((e as Error).message, 'err'); } }}>Save</button>
          {s?.set && <button className="btn ghost" onClick={async () => { await del(`/api/workspaces/${wsId}/secrets/ncbi_api_key`); void load(); }}>Remove</button>}</div>
        <div className="small muted">NCBI key in the server environment: <b>{d.server.ncbi ? 'yes' : 'no'}</b></div></div></div>
      <div className="panel"><header><h3>Databases used</h3></header><div className="pb small muted">NCBI E-utilities, Taxonomy and BLAST · UniProt · AlphaFold DB · InterPro · RCSB PDB · PubChem · ChEMBL · BindingDB · OpenStreetMap Nominatim. All are public; requests are rate limited per host and every answer is kept in the local cache, so it is still there offline. The source and retrieval date of every fetched item are stored with it.</div></div>
    </div>
  );
}

function NotificationHint() {
  return <div className="notice">Notifications are shown inside VierStation (and, if you allow it, as browser notifications while the page is open). Choose which events notify you on the <a href="/notifications">Notifications page</a>. VierStation does not send e-mail.</div>;
}

function Audit({ wsId }: { wsId: string }) {
  const [e, setE] = useState<{ id: number; ts: string; action: string; user: string | null; targetType: string | null; targetId: string | null; detail: unknown }[] | null>(null);
  useEffect(() => { get(`/api/workspaces/${wsId}/audit?limit=200`).then((r) => setE(r.entries), () => setE([])); }, [wsId]);
  if (!e) return <Spinner />;
  return (
    <div className="col"><div className="small muted">What happened to your data, in order. Entries are labelled with the local workspace identity – there are no user accounts.</div>
      <div className="panel" style={{ overflow: 'auto' }}><table className="t"><thead><tr><th>When</th><th>Action</th><th>Target</th><th className="hide-m">Details</th></tr></thead><tbody>
        {e.map((x) => <tr key={x.id}><td className="small">{ago(x.ts)}<div className="muted">{x.ts.slice(0, 16).replace('T', ' ')}</div></td><td><code>{x.action}</code></td><td className="small">{x.targetType}<div className="muted">{x.targetId}</div></td><td className="small muted hide-m">{x.detail ? JSON.stringify(x.detail).slice(0, 120) : ''}</td></tr>)}
      </tbody></table></div></div>
  );
}

function About() {
  const [info, setInfo] = useState<any>(null);
  const [terms, setTerms] = useState<string | null>(null); const [open, setOpen] = useState(false);
  useEffect(() => { get('/api/local/info').then(setInfo, () => {}); }, []);
  return (
    <div className="panel" style={{ maxWidth: 640 }}><header><h3>VierStation</h3></header><div className="pb col">
      <div>Scientific research and bioinformatics workspace by VierApparatus. Offline-first, no accounts, your data stays on this computer.</div>
      <table className="t"><tbody><tr><td>Version</td><td>{info?.version ?? '…'}</td></tr><tr><td>Runtime</td><td>Node {info?.node ?? '…'}</td></tr><tr><td>Data folder</td><td className="small"><code>{info?.dataDir ?? '…'}</code></td></tr><tr><td>Local identity (audit log only)</td><td className="small">{info?.identity?.id ?? '…'}</td></tr></tbody></table>
      <div className="small muted">Results from databases carry their source and retrieval date; conclusions are always made by a person.</div>
      <div className="row"><button className="btn secondary" onClick={() => { setOpen((o) => !o); if (!terms) get('/api/app/terms').then((r) => setTerms(r.text), () => {}); }} aria-expanded={open}>{open ? 'Hide' : 'Show'} terms of use and disclaimer</button></div>
      {open && terms && <Terms text={terms} />}
    </div></div>
  );
}
