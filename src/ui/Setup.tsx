// First-run setup: a small installer-style dialog with lab name, data folder and acceptance of the terms of use.
// Layout is a fixed-height card: header, scrolling body (fields + terms) and a footer that is always visible.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { get, put } from '../lib/api.ts';
import { loadMe, toast, useSession } from '../lib/store.ts';
import { Spinner } from './common.tsx';
import '../setup.css';

/** Very small renderer for TERMS.md (headings, bullets, paragraphs, bold). The text is ours, not user input. */
export function Terms({ text }: { text: string }) {
  const out: ReactNode[] = []; let list: string[] = [];
  const flush = () => { if (list.length) { out.push(<ul key={`u${out.length}`}>{list.map((l, i) => <li key={i}>{bold(l)}</li>)}</ul>); list = []; } };
  text.split('\n').forEach((raw, i) => {
    const l = raw.replace(/\s+$/, '');
    if (l.startsWith('- ')) { list.push(l.slice(2)); return; }
    flush();
    if (l.startsWith('# ')) out.push(<h3 key={i}>{l.slice(2)}</h3>);
    else if (l.startsWith('## ')) out.push(<h4 key={i}>{l.slice(3)}</h4>);
    else if (l.trim()) out.push(<p key={i}>{bold(l)}</p>);
  });
  flush();
  return <div className="terms">{out}</div>;
}
function bold(s: string) { return s.split(/\*\*(.+?)\*\*/g).map((p, i) => (i % 2 ? <b key={i}>{p}</b> : p)); }

export function FirstRun() {
  const setup = useSession((s) => s.setup);
  const wsId = useSession((s) => s.wsId);
  const wsName = useSession((s) => s.workspaces.find((w) => w.id === s.wsId)?.name ?? '');
  const [name, setName] = useState(setup?.labName ?? wsName);
  const [dir, setDir] = useState(setup?.dataDirConfigured ?? setup?.dataDir ?? '');
  const [terms, setTerms] = useState<string | null>(null);
  const [agree, setAgree] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { get('/api/app/terms').then((r) => setTerms(r.text), () => setErr('The terms could not be loaded. Restart VierStation.')); }, []);
  const accept = async () => {
    setBusy(true); setErr('');
    try {
      const r = await put('/api/app/setup', { labName: name, dataDir: dir, acceptTerms: true, workspaceId: wsId });
      await loadMe();
      // the desktop shell (if present) enlarges the window from the small installer size to the full application size
      (window as unknown as { vierstationDesktop?: { setupDone: () => void } }).vierstationDesktop?.setupDone();
      if (r.restartRequired) toast('Data folder saved. Restart VierStation to start using it.', 'info');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="setup-shell">
      <div className="setup-card" role="dialog" aria-labelledby="setup-title">
        <header className="setup-head">
          <img src="/brand/icon.svg" alt="" width={34} height={34} />
          <div><h2 id="setup-title">Set up VierStation</h2><div className="muted small">Your data stays on this computer.</div></div>
        </header>
        <div className="setup-body">
          <label className="field">Lab name <span className="muted small">shown in the app and on exports</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Smith Lab" aria-label="Lab name" /></label>
          <label className="field">Data folder <span className="muted small">applied after a restart</span>
            <input className="input" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="C:\Users\you\VierStation\data" aria-label="Data folder" /></label>
          <div className="setup-terms-title">Terms of use</div>
          <div className="setup-terms" tabIndex={0} aria-label="Terms of use">
            {terms ? <Terms text={terms} /> : <Spinner label="Loading the terms…" />}
          </div>
        </div>
        <footer className="setup-foot">
          {err && <div className="notice err" role="alert">{err}</div>}
          <label className="check setup-agree"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I have read and accept the terms of use and the disclaimer.</label>
          <div className="setup-buttons">
            <button className="btn" disabled={!agree || !name.trim() || !terms || busy} onClick={() => void accept()}>{busy ? <Spinner /> : null} Accept and continue</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
