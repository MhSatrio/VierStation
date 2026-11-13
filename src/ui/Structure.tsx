import { useEffect, useMemo, useRef, useState } from 'react';
import { get } from '../lib/api.ts';
import { Empty } from './common.tsx';
import { Icon } from './icons.tsx';

// AlphaFold's published pLDDT colour bands.
const PLDDT = [{ min: 90, c: '#0053D6', l: 'Very high (>90)' }, { min: 70, c: '#65CBF3', l: 'Confident (70–90)' }, { min: 50, c: '#FFDB13', l: 'Low (50–70)' }, { min: 0, c: '#FF7D45', l: 'Very low (<50)' }];
const plddtColor = (b: number) => (PLDDT.find((x) => b >= x.min) ?? PLDDT[3]).c;
type Rep = 'cartoon' | 'stick' | 'sphere' | 'line' | 'surface';
type Scheme = 'confidence' | 'chain' | 'spectrum' | 'residue' | 'secondary';

interface AfInfo { available: boolean; entryId?: string; version?: number; meanPlddt?: number; fractions?: { veryLow: number; low: number; confident: number; veryHigh: number }; paeImageUrl?: string; residues?: { resi: number; aa: string; plddt: number }[]; organism?: string; gene?: string; description?: string; tool?: string }

/**
 * Interactive viewer. 3Dmol (≈157 KB gzip) is imported on demand – it is the smallest of the candidates measured
 * (NGL ≈358 KB, Mol* ≈1.5 MB gzip) and supports PDB/mmCIF, per-atom colouring (pLDDT), residue selection and picking.
 */
export function StructureViewer({ src, id, title }: { src: 'alphafold' | 'pdb'; id: string; title?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<any>(null);
  const lib = useRef<any>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState<AfInfo | null>(null);
  const [rep, setRep] = useState<Rep>('cartoon');
  const [scheme, setScheme] = useState<Scheme>(src === 'alphafold' ? 'confidence' : 'chain');
  const [hl, setHl] = useState('');
  const [picked, setPicked] = useState<{ resn: string; resi: number; chain: string; b: number; atom: string } | null>(null);
  const [nRes, setNRes] = useState(0);
  const modelText = useRef('');

  useEffect(() => {
    let dead = false;
    setState('loading'); setErr(''); setInfo(null); setPicked(null);
    (async () => {
      try {
        const [txt, mod, meta] = await Promise.all([
          fetch(`/api/structures/model?src=${src}&id=${encodeURIComponent(id)}`, { credentials: 'same-origin' }).then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Structure file unavailable (${r.status})`); return r.text(); }),
          import('3dmol'),
          src === 'alphafold' ? get<AfInfo>(`/api/structures/info?uniprot=${encodeURIComponent(id)}`) : Promise.resolve(null),
        ]);
        if (dead || !host.current) return;
        lib.current = (mod as any).default ?? mod;
        modelText.current = txt;
        viewer.current = lib.current.createViewer(host.current, { backgroundColor: '#0f1724', antialias: true });
        viewer.current.addModel(txt, 'pdb');
        setNRes(new Set(viewer.current.selectedAtoms({ atom: 'CA' }).map((a: any) => a.chain + a.resi)).size);
        viewer.current.setClickable({}, true, (atom: any) => setPicked({ resn: atom.resn, resi: atom.resi, chain: atom.chain, b: atom.b, atom: atom.atom }));
        setInfo(meta);
        setState('ready');
      } catch (e) { if (!dead) { setErr((e as Error).message); setState('error'); } }
    })();
    return () => { dead = true; try { viewer.current?.clear(); } catch { /* ignore */ } viewer.current = null; };
  }, [src, id]);

  const highlights = useMemo(() => {
    const out: number[] = [];
    for (const part of hl.split(/[,\s]+/).filter(Boolean)) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!m) continue;
      const a = Number(m[1]), b = Number(m[2] ?? m[1]);
      for (let i = a; i <= Math.min(b, a + 2000); i++) out.push(i);
    }
    return out;
  }, [hl]);

  // restyle whenever representation / colouring / highlights change
  useEffect(() => {
    const v = viewer.current, $ = lib.current;
    if (state !== 'ready' || !v) return;
    const color: any = scheme === 'confidence' ? { colorfunc: (a: any) => plddtColor(a.b) } : scheme === 'chain' ? { colorscheme: 'chain' } : scheme === 'spectrum' ? { color: 'spectrum' } : scheme === 'residue' ? { colorscheme: 'amino' } : { colorscheme: 'ssPyMol' };
    v.removeAllSurfaces(); v.removeAllLabels();
    v.setStyle({}, rep === 'surface' ? { cartoon: { ...color, opacity: 0.6 } } : { [rep]: rep === 'sphere' ? { ...color, scale: 0.35 } : rep === 'line' ? { ...color } : color });
    if (rep === 'surface' && nRes < 1800) v.addSurface($.SurfaceType.VDW, { opacity: 0.85, ...color }, {});
    if (highlights.length) {
      v.addStyle({ resi: highlights }, { stick: { colorscheme: 'orangeCarbon', radius: 0.22 } });
      v.addStyle({ resi: highlights }, { cartoon: { color: '#ffb000', thickness: 1.4 } });
    }
    if (picked) v.addLabel(`${picked.resn}${picked.resi}`, { position: { resi: picked.resi, chain: picked.chain, atom: picked.atom }, backgroundColor: '#231f20', fontColor: '#fff', fontSize: 12, backgroundOpacity: 0.85 });
    v.render();
  }, [state, rep, scheme, highlights, picked, nRes]);

  const first = useRef(true);
  useEffect(() => { if (state === 'ready' && first.current) { viewer.current.zoomTo(); viewer.current.render(); first.current = false; } }, [state]);
  useEffect(() => { first.current = true; }, [src, id]);
  const focus = (resi: number) => { setHl(String(resi)); viewer.current?.zoomTo({ resi }, 400); };

  if (state === 'error') return <Empty title="3D structure unavailable">{err}</Empty>;
  const conf = info?.fractions;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div style={{ position: 'relative' }}>
        {/* the host element is owned by 3Dmol: it must never have React children */}
        <div className="viewer" ref={host} role="img" aria-label={`3D structure of ${title ?? id}. Drag to rotate, scroll to zoom, right-drag to pan.`} />
        {state === 'loading' && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#cfe0f5', pointerEvents: 'none' }}><span><span className="spinner" /> Loading structure…</span></div>}
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <label className="field" style={{ flex: '1 1 130px' }}>Representation<select className="select" value={rep} onChange={(e) => setRep(e.target.value as Rep)}>{(['cartoon', 'stick', 'sphere', 'line', 'surface'] as Rep[]).map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
        <label className="field" style={{ flex: '1 1 150px' }}>Colour by<select className="select" value={scheme} onChange={(e) => setScheme(e.target.value as Scheme)}>{src === 'alphafold' && <option value="confidence">pLDDT confidence</option>}<option value="chain">Chain</option><option value="spectrum">Sequence (N→C)</option><option value="residue">Residue type</option><option value="secondary">Secondary structure</option></select></label>
        <label className="field" style={{ flex: '1 1 150px' }}>Highlight residues<input className="input" placeholder="e.g. 175, 245-250" value={hl} onChange={(e) => setHl(e.target.value)} /></label>
      </div>
      <div className="row wrap small">
        <a className="btn secondary sm" href={`/api/structures/model?src=${src}&id=${encodeURIComponent(id)}`} download={`${src === 'alphafold' ? `AF-${id}` : id}.pdb`}><Icon name="download" /> Download coordinates (PDB)</a>
        <button className="btn ghost sm" onClick={() => { viewer.current?.zoomTo(); viewer.current?.render(); }}><Icon name="refresh" /> Reset view</button>
        {picked && <span className="chip blue">Selected: {picked.resn} {picked.resi} (chain {picked.chain}) · {src === 'alphafold' ? `pLDDT ${picked.b.toFixed(1)}` : `B-factor ${picked.b.toFixed(1)}`}</span>}
        {rep === 'surface' && nRes >= 1800 && <span className="muted">Surface skipped: {nRes} residues is too large for the browser.</span>}
      </div>
      {src === 'alphafold' && info?.available && (
        <div className="evbox">
          <div className="row wrap between"><b>{info.entryId} · v{info.version}</b><span className="chip amber">Predicted structure</span></div>
          <div className="small">Mean pLDDT <b>{info.meanPlddt}</b> · {info.tool}. AlphaFold models are computational predictions; they are not experimental evidence and say nothing by themselves about whether a chemical binds this protein.</div>
          {conf && <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden' }} title="Share of residues per confidence band">{[['veryHigh', 0], ['confident', 1], ['low', 2], ['veryLow', 3]].map(([k, i]) => <span key={k as string} style={{ width: `${(conf as any)[k as string] * 100}%`, background: PLDDT[i as number].c }} />)}</div>}
          <div className="row wrap small" style={{ gap: 10 }}>{PLDDT.map((b, i) => <span key={b.l}><i style={{ display: 'inline-block', width: 9, height: 9, background: b.c, borderRadius: 2, marginRight: 4 }} />{b.l}{conf ? ` ${Math.round(((conf as any)[['veryHigh', 'confident', 'low', 'veryLow'][i]] ?? 0) * 100)}%` : ''}</span>)}</div>
          {info.residues && <PlddtPlot residues={info.residues} onPick={focus} />}
          {info.paeImageUrl && <details><summary className="small">Predicted aligned error (PAE)</summary><img src={info.paeImageUrl} alt="Predicted aligned error matrix" style={{ maxWidth: '100%', marginTop: 6 }} /><div className="muted small">Low error (dark) between two regions means AlphaFold is confident about their relative position.</div></details>}
        </div>
      )}
      {src === 'pdb' && <div className="evbox small"><div className="row between"><b>{id.toUpperCase()}</b><span className="chip green">Experimental structure</span></div><a href={`https://www.rcsb.org/structure/${id}`} target="_blank" rel="noreferrer noopener">View on RCSB PDB ↗</a></div>}
    </div>
  );
}

function PlddtPlot({ residues, onPick }: { residues: { resi: number; aa: string; plddt: number }[]; onPick: (resi: number) => void }) {
  const W = 520, H = 70;
  const [h, setH] = useState<number | null>(null);
  const pts = residues.map((r, i) => `${(i / Math.max(1, residues.length - 1)) * W},${H - (r.plddt / 100) * H}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 4}`} style={{ width: '100%', height: 84, cursor: 'crosshair' }} role="img" aria-label="Per-residue pLDDT"
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setH(Math.min(residues.length - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * (residues.length - 1))))); }} onMouseLeave={() => setH(null)} onClick={() => h !== null && onPick(residues[h].resi)}>
        {[90, 70, 50].map((y) => <line key={y} x1="0" x2={W} y1={H - (y / 100) * H} y2={H - (y / 100) * H} stroke="rgb(35 31 32 / .15)" strokeDasharray="3 3" />)}
        <polyline points={pts} fill="none" stroke="#4570b6" strokeWidth="1.5" />
        {h !== null && <line x1={(h / Math.max(1, residues.length - 1)) * W} x2={(h / Math.max(1, residues.length - 1)) * W} y1="0" y2={H} stroke="#231f20" />}
      </svg>
      <div className="small muted" style={{ minHeight: 18 }}>{h !== null ? `${residues[h].aa} ${residues[h].resi}: pLDDT ${residues[h].plddt.toFixed(1)} (click to highlight)` : 'Per-residue confidence – hover a position, click to highlight it in the structure.'}</div>
    </div>
  );
}
