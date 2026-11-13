// Sample map: a rotatable globe (drawn on a canvas, no map library, no tile server) with one pin per sample.
// Pin colour = how precisely the place is known: DARK navy = specific / nearly exact, getting lighter = more uncertain, near-white = only the country is known.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, post } from '../lib/api.ts';
import { Link, useQueryParam } from '../lib/router.tsx';
import { toast, useEvent, useSession } from '../lib/store.ts';
import { PRECISIONS, precisionById } from '../../shared/geo.ts';
import type { GeoPoint } from '../../shared/geo.ts';
import { Chip, Empty, Spinner } from './common.tsx';
import { Icon } from './icons.tsx';
import { JobLine } from './RecordPanel.tsx';

interface Country { name: string; polys: number[][][][] }
interface Unlocated { id: string; name: string; location: string }
const RAD = Math.PI / 180;

function project(lon: number, lat: number, lon0: number, lat0: number, R: number, cx: number, cy: number): [number, number, boolean] {
  const l = (lon - lon0) * RAD, p = lat * RAD, p0 = lat0 * RAD;
  const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l);
  let x = Math.cos(p) * Math.sin(l), y = Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l);
  if (cosc < 0) { const n = Math.hypot(x, y) || 1; x /= n; y /= n; } // behind the horizon: slide the point onto the edge of the disc (the shape is clipped to the disc)
  return [cx + R * x, cy - R * y, cosc >= 0];
}

function Globe({ points, countries, selected, onSelect, showHalo, canvasRef }: { points: GeoPoint[]; countries: Country[]; selected: string | null; onSelect: (id: string | null) => void; showHalo: boolean; canvasRef: React.MutableRefObject<HTMLCanvasElement | null> }) {
  const view = useRef({ lon0: 105, lat0: 5, zoom: 1 });
  const pins = useRef<{ id: string; x: number; y: number }[]>([]);
  const [, force] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const draw = useCallback(() => {
    const cv = canvasRef.current, box = wrap.current; if (!cv || !box) return;
    const dpr = window.devicePixelRatio || 1, w = box.clientWidth, h = Math.min(560, Math.max(340, Math.round(w * 0.62)));
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = `${h}px`; }
    const ctx = cv.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const { lon0, lat0, zoom } = view.current, R = (Math.min(w, h) / 2 - 10) * zoom, cx = w / 2, cy = h / 2;
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#D3E4F4'; ctx.fillRect(0, 0, w, h); // ocean
    ctx.strokeStyle = 'rgba(69,112,182,.16)'; ctx.lineWidth = 0.6; // graticule every 30°
    for (let lat = -60; lat <= 60; lat += 30) { ctx.beginPath(); for (let lon = -180; lon <= 180; lon += 5) { const [x, y] = project(lon, lat, lon0, lat0, R, cx, cy); lon === -180 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke(); }
    for (let lon = -180; lon < 180; lon += 30) { ctx.beginPath(); for (let lat = -90; lat <= 90; lat += 5) { const [x, y] = project(lon, lat, lon0, lat0, R, cx, cy); lat === -90 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke(); }
    ctx.fillStyle = '#FBFCFD'; ctx.strokeStyle = '#8FA6C4'; ctx.lineWidth = 0.7; // land
    for (const c of countries) for (const poly of c.polys) {
      ctx.beginPath();
      poly.forEach((ring, ri) => { ring.forEach(([lo, la], i) => { const [x, y] = project(lo, la, lon0, lat0, R, cx, cy); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }); ctx.closePath(); void ri; });
      ctx.fill('evenodd'); ctx.stroke();
    }
    const placed = points.map((p) => ({ p, xy: project(p.lon, p.lat, lon0, lat0, R, cx, cy) })).filter((o) => o.xy[2]);
    placed.sort((a, b) => precisionById(b.p.precision).radiusKm - precisionById(a.p.precision).radiusKm); // vague pins first, specific ones on top
    if (showHalo) for (const { p, xy } of placed) { // how far off the pin may be
      const r = Math.min(R * 0.5, Math.max(6, (R * precisionById(p.precision).radiusKm) / 6371));
      ctx.beginPath(); ctx.arc(xy[0], xy[1], r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(69,112,182,.10)'; ctx.fill(); ctx.strokeStyle = 'rgba(69,112,182,.35)'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    }
    pins.current = [];
    for (const { p, xy } of placed) {
      const info = precisionById(p.precision), sel = p.id === selected, r = sel ? 9 : 7;
      ctx.beginPath(); ctx.arc(xy[0], xy[1], r + 2.2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); // white ring so a light pin stays visible on the land
      ctx.beginPath(); ctx.arc(xy[0], xy[1], r, 0, Math.PI * 2); ctx.fillStyle = info.color; ctx.fill(); ctx.lineWidth = sel ? 2.4 : 1.3; ctx.strokeStyle = sel ? '#231F20' : '#14295A'; ctx.stroke();
      pins.current.push({ id: p.id, x: xy[0], y: xy[1] });
    }
    ctx.restore();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.strokeStyle = '#4570B6'; ctx.lineWidth = 1.5; ctx.stroke();
  }, [points, countries, selected, showHalo, canvasRef]);
  useEffect(() => { draw(); const ro = new ResizeObserver(draw); if (wrap.current) ro.observe(wrap.current); return () => ro.disconnect(); }, [draw]);
  const fit = useCallback(() => { // turn the globe to the centre of the pins
    if (!points.length) return;
    let x = 0, y = 0, z = 0; for (const p of points) { x += Math.cos(p.lat * RAD) * Math.cos(p.lon * RAD); y += Math.cos(p.lat * RAD) * Math.sin(p.lon * RAD); z += Math.sin(p.lat * RAD); }
    view.current.lon0 = Math.atan2(y, x) / RAD; view.current.lat0 = Math.atan2(z, Math.hypot(x, y)) / RAD; view.current.zoom = 1; draw(); force((n) => n + 1);
  }, [points, draw]);
  useEffect(() => { if (points.length) fit(); }, [points.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const hit = (e: React.PointerEvent) => { const r = canvasRef.current!.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; return [...pins.current].reverse().find((p) => Math.hypot(p.x - x, p.y - y) <= 11)?.id ?? null; };
  return (
    <div ref={wrap} style={{ position: 'relative', touchAction: 'none' }}>
      <canvas ref={canvasRef} tabIndex={0} role="img" aria-label={`Globe with ${points.length} sample pin${points.length === 1 ? '' : 's'}. The same information is listed in the table below. Arrow keys rotate the globe, plus and minus zoom.`} style={{ width: '100%', display: 'block', cursor: 'grab', borderRadius: 12, background: '#fff' }}
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current; if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y; if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true; d.x = e.clientX; d.y = e.clientY; const k = 0.45 / view.current.zoom; view.current.lon0 -= dx * k; view.current.lat0 = Math.max(-85, Math.min(85, view.current.lat0 + dy * k)); draw(); }}
        onPointerUp={(e) => { const d = drag.current; drag.current = null; if (d && !d.moved) onSelect(hit(e)); }}
        onWheel={(e) => { e.preventDefault(); view.current.zoom = Math.max(0.8, Math.min(8, view.current.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); draw(); }}
        onKeyDown={(e) => { const v = view.current; if (e.key === 'ArrowLeft') v.lon0 -= 8 / v.zoom; else if (e.key === 'ArrowRight') v.lon0 += 8 / v.zoom; else if (e.key === 'ArrowUp') v.lat0 = Math.min(85, v.lat0 + 8 / v.zoom); else if (e.key === 'ArrowDown') v.lat0 = Math.max(-85, v.lat0 - 8 / v.zoom); else if (e.key === '+' || e.key === '=') v.zoom = Math.min(8, v.zoom * 1.2); else if (e.key === '-') v.zoom = Math.max(0.8, v.zoom / 1.2); else return; e.preventDefault(); draw(); }} />
      <div className="row" style={{ position: 'absolute', right: 10, top: 10, gap: 6 }}>
        <button className="btn secondary sm" onClick={fit} disabled={!points.length}>Centre on pins</button>
        <button className="btn secondary sm" onClick={() => { view.current.zoom = Math.min(8, view.current.zoom * 1.4); draw(); }} aria-label="Zoom in">+</button>
        <button className="btn secondary sm" onClick={() => { view.current.zoom = Math.max(0.8, view.current.zoom / 1.4); draw(); }} aria-label="Zoom out">−</button>
      </div>
    </div>
  );
}

function Legend({ counts }: { counts: Record<string, number> }) {
  return (
    <div className="panel"><div className="pb col">
      <b>How precise is each pin?</b>
      <div style={{ height: 12, borderRadius: 6, background: `linear-gradient(90deg, ${PRECISIONS.map((p) => p.color).join(',')})`, border: '1px solid #9BB0C9' }} aria-hidden="true" />
      <div className="row between small muted"><span>dark navy = specific, nearly exact</span><span>white = only a country (or nothing) is known</span></div>
      <table className="t"><tbody>{PRECISIONS.map((p) => (
        <tr key={p.id}><td style={{ width: 28 }}><span style={{ display: 'inline-block', width: 16, height: 16, borderRadius: 8, background: p.color, border: '1.5px solid #14295A' }} aria-hidden="true" /></td><td><b>{p.label}</b><div className="small muted">{p.text}</div></td><td className="small muted">±{p.radiusKm < 1 ? `${p.radiusKm * 1000} m` : `${p.radiusKm} km`}</td><td style={{ textAlign: 'right' }}>{counts[p.id] ?? 0}</td></tr>))}</tbody></table>
      <div className="small muted">The dashed ring around a pin shows how far the true place may be from the pin (a typical size for that class, not a measurement). Country outlines: Natural Earth (public domain). Place-name lookups: © OpenStreetMap contributors (ODbL).</div>
    </div></div>
  );
}

export function MapPage() {
  const lab = useQueryParam('lab');
  const { projectId, wsId } = useSession((s) => ({ projectId: s.projectId, wsId: s.wsId }));
  const [data, setData] = useState<{ points: GeoPoint[]; unlocated: Unlocated[]; unresolved?: { label: string; accession: string | null; organism: string; reason: string }[]; withoutLocation?: number; total?: number } | null>(null);
  const [labName, setLabName] = useState('');
  const [world, setWorld] = useState<Country[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [halo, setHalo] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const load = useCallback(async () => {
    try {
      if (lab) { const r = await get(`/api/lab/${lab}/geo`); setData({ points: r.points, unlocated: [], unresolved: r.unresolved }); setLabName((await get(`/api/lab/${lab}`)).name ?? ''); }
      else setData(await get(`/api/geo/points${projectId ? `?project=${projectId}` : wsId ? `?workspace=${wsId}` : ''}`));
      setErr('');
    } catch (e) { setErr((e as Error).message); }
  }, [lab, projectId, wsId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { get('/api/geo/world').then((r) => setWorld(r.countries), () => {}); }, []);
  useEvent('job.changed', (e) => { if (e.jobId === jobId && ['completed', 'failed', 'cancelled'].includes(e.status)) { setJobId(null); void load(); } }, [jobId, load]);
  const start = async (path: string, body: unknown) => { try { const r = await post(path, body); if (r.jobId) setJobId(r.jobId); } catch (e) { toast((e as Error).message, 'err'); } };
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const p of data?.points ?? []) c[p.precision] = (c[p.precision] ?? 0) + 1; return c; }, [data]);
  const selected = data?.points.find((p) => p.id === sel) ?? null;
  const rows = useMemo(() => [...(data?.points ?? [])].sort((a, b) => precisionById(a.precision).radiusKm - precisionById(b.precision).radiusKm || a.name.localeCompare(b.name)), [data]);
  const png = () => { const cv = canvas.current; if (!cv) return; const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = lab ? 'sample-map-tree.png' : 'sample-map.png'; a.click(); };
  if (err) return <div className="page"><Empty title="Cannot load the map">{err}</Empty></div>;
  if (!data) return <div className="page"><Spinner /></div>;
  return (
    <div className="page">
      <div className="row between wrap"><h1>{lab ? <>Sample map – {labName || 'this sequence'}</> : 'Sample map'}</h1>
        <div className="row wrap">
          {lab && <Link to={`/lab/${lab}`} className="btn ghost sm">Back to the Sequence Lab</Link>}
          {lab && <button className="btn secondary" disabled={!!jobId} onClick={() => start(`/api/lab/${lab}/geo/locate`, {})}><Icon name="play" /> Find collection places of the references</button>}
          <button className="btn secondary sm" onClick={png}><Icon name="download" /> PNG</button>
        </div></div>
      <p className="lead">{lab ? 'Where the sequence you are identifying and its reference sequences were collected (read from their GenBank records).' : 'Where your DNA samples were collected. Fill in “Collection location” in the DNA table (a suburb, city, province or country) and VierStation finds the coordinates; or enter latitude and longitude yourself.'}</p>
      {jobId && <JobLine id={jobId} />}
      {(data.unlocated.length > 0 && !lab) && <div className="notice warn row wrap"><span><b>{data.unlocated.length}</b> record(s) have a place name but no coordinates yet.</span><button className="btn sm" disabled={!!jobId} onClick={() => start('/api/geo/locate', { recordIds: data.unlocated.map((u) => u.id) })}>Find coordinates</button><span className="small muted">One OpenStreetMap lookup per second; a bare country needs none. Coordinates you typed yourself are never overwritten.</span></div>}
      <div className="panel"><div className="pb col">
        <Globe points={data.points} countries={world} selected={sel} onSelect={setSel} showHalo={halo} canvasRef={canvas} />
        <div className="row wrap"><label className="check"><input type="checkbox" checked={halo} onChange={(e) => setHalo(e.target.checked)} />Show the uncertainty ring around each pin</label><span className="small muted">Drag to rotate · scroll to zoom · click a pin for details</span><Chip color="blue">{data.points.length} pin{data.points.length === 1 ? '' : 's'}</Chip></div>
        {selected && <div className="notice"><div className="row wrap"><span style={{ display: 'inline-block', width: 16, height: 16, borderRadius: 8, background: precisionById(selected.precision).color, border: '1.5px solid #14295A' }} aria-hidden="true" /><b>{selected.name}</b><Chip color="sky">{precisionById(selected.precision).label}</Chip>{selected.kind === 'reference' && <Chip color="gray">reference sequence</Chip>}{selected.kind === 'query' && <Chip color="blue">your sequence</Chip>}</div>
          <div className="small">{selected.location || '—'} · {selected.lat.toFixed(4)}, {selected.lon.toFixed(4)} · source: {selected.source || '—'}{selected.note ? ` · ${selected.note}` : ''}</div>
          {selected.recordId && <Link to={`/record/${selected.recordId}`} className="small">Open the record</Link>}</div>}
      </div></div>
      <Legend counts={counts} />
      {data.points.length === 0 && <Empty title="No pins yet">Add coordinates or a place name to the DNA records (columns “Collection location”, “Latitude”, “Longitude”), or save BLAST hits to the DNA table – GenBank often states where a sample was collected.</Empty>}
      {rows.length > 0 && <div className="panel" style={{ overflow: 'auto' }}><table className="t"><thead><tr><th>Sample</th><th>Place</th><th>Precision</th><th>Latitude, longitude</th><th>Where the coordinates come from</th></tr></thead><tbody>{rows.map((p) => (
        <tr key={p.id} className="hitrow" onClick={() => setSel(p.id)}><td><b>{p.name}</b>{p.accession && <div className="small muted">{p.accession}</div>}</td><td>{p.location || '—'}</td><td><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 6, background: precisionById(p.precision).color, border: '1.2px solid #14295A', marginRight: 6 }} aria-hidden="true" />{precisionById(p.precision).label}</td><td className="small">{p.lat.toFixed(4)}, {p.lon.toFixed(4)}</td><td className="small muted">{p.source || '—'}</td></tr>))}</tbody></table></div>}
      {(data.unlocated.length > 0 && !lab) && <details><summary className="small"><b>{data.unlocated.length}</b> record(s) with a place name but no coordinates</summary><table className="t"><tbody>{data.unlocated.map((u) => <tr key={u.id}><td><Link to={`/record/${u.id}`}>{u.name}</Link></td><td className="small">{u.location}</td></tr>)}</tbody></table></details>}
      {lab && (data.unresolved?.length ?? 0) > 0 && <details open><summary className="small"><b>{data.unresolved!.length}</b> reference sequence(s) without a usable place – not guessed</summary><table className="t"><tbody>{data.unresolved!.map((u, i) => <tr key={i}><td>{u.organism}<div className="small muted">{u.accession}</div></td><td className="small">{u.reason}</td></tr>)}</tbody></table></details>}
      {!lab && (data.withoutLocation ?? 0) > 0 && <div className="small muted">{data.withoutLocation} of {data.total} DNA record(s) have no collection location at all.</div>}
    </div>
  );
}
