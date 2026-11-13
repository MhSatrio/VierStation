// Interactive phylogenetic tree viewer (SVG): rectangular / cladogram / circular layouts, zoom & pan, collapse clades, highlight, support values, export.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent, ReactElement } from 'react';
import { toast } from '../../lib/store.ts';
import { Icon } from '../icons.tsx';
import { HelpTip, Hint, Lbl } from '../Tip.tsx';

export interface TNode { name?: string; leaf?: number; length: number; support?: number; children?: TNode[]; splitKey?: string }
export interface MemberInfo { organism: string; accession: string | null; role: string }
type LayoutKind = 'rect' | 'clado' | 'circ';
interface L { id: string; node: TNode; children: L[]; x: number; y: number; depth: number; leaves: number; collapsed: boolean; tips: string[]; parent: L | null }

function build(n: TNode, id: string, parent: L | null, collapsed: Set<string>, x0: number, clado: boolean): L {
  const l: L = { id, node: n, children: [], x: 0, y: 0, depth: 0, leaves: 0, collapsed: false, tips: [], parent };
  const len = clado ? 1 : Math.max(0, n.length || 0);
  l.x = x0 + (parent ? len : 0);
  const kids = n.children ?? [];
  if (!kids.length) { l.tips = [n.name ?? '']; l.leaves = 1; return l; }
  l.collapsed = collapsed.has(id);
  l.children = kids.map((k, i) => build(k, `${id}.${i}`, l, collapsed, l.x, clado));
  l.tips = l.children.flatMap((c) => c.tips); l.leaves = l.children.reduce((a, c) => a + c.leaves, 0);
  return l;
}
const visibleLeaves = (l: L): L[] => (l.children.length && !l.collapsed ? l.children.flatMap(visibleLeaves) : [l]);

export function TreeViewer({ tree, members, queryLabel, scaleUnit = 'substitutions/site', support = true, filename = 'tree' }: { tree: TNode; members: Record<string, MemberInfo>; queryLabel?: string | null; scaleUnit?: string; support?: boolean; filename?: string }) {
  const [layout, setLayout] = useState<LayoutKind>('rect');
  const [showSupport, setShowSupport] = useState(support);
  const [labelMode, setLabelMode] = useState<'both' | 'organism' | 'accession'>('both');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hl, setHl] = useState<string | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const root = useMemo(() => build(tree, 'r', null, collapsed, 0, layout === 'clado'), [tree, collapsed, layout]);
  const leaves = useMemo(() => visibleLeaves(root), [root]);
  const maxX = useMemo(() => { let m = 0; const walk = (l: L) => { m = Math.max(m, l.x); if (!l.collapsed) l.children.forEach(walk); }; walk(root); return m || 1; }, [root]);
  const ROW = 22, LABEL = 250, W = 1000, H = Math.max(260, leaves.length * ROW + 50);
  const label = (name: string) => { const m = members[name]; if (!m) return name; if (m.role === 'query') return `Query: ${name.replace(/^Query_/, '')}`; return labelMode === 'organism' ? m.organism : labelMode === 'accession' ? (m.accession ?? name) : `${m.organism}${m.accession ? ` · ${m.accession}` : ''}`; };

  // positions
  const pos = useMemo(() => {
    const map = new Map<string, { x: number; y: number; a?: number; r?: number }>();
    const plotW = W - LABEL - 20;
    const cladoTipX = layout === 'clado' ? (() => { let d = 0; const walk = (l: L, k: number) => { d = Math.max(d, k); if (!l.collapsed) l.children.forEach((c) => walk(c, k + 1)); }; walk(root, 0); return d; })() : 0;
    leaves.forEach((l, i) => { l.y = layout === 'circ' ? (i / leaves.length) * Math.PI * 2 : 20 + i * ROW; });
    const setY = (l: L): number => { if (!l.children.length || l.collapsed) return l.y; const ys = l.children.map(setY); l.y = layout === 'circ' ? circMean(ys) : (Math.min(...ys) + Math.max(...ys)) / 2; return l.y; };
    setY(root);
    const R = Math.min(W, H) / 2 - 150;
    const walk = (l: L) => {
      let xv = layout === 'clado' ? ((l.children.length && !l.collapsed ? l.x : cladoTipX) / (cladoTipX || 1)) : l.x / maxX;
      if (layout === 'clado' && (!l.children.length || l.collapsed)) xv = 1;
      if (layout === 'circ') { const r = 20 + xv * R, a = l.y; map.set(l.id, { x: W / 2 + r * Math.cos(a), y: H / 2 + r * Math.sin(a), a, r }); }
      else map.set(l.id, { x: 10 + xv * plotW, y: l.y });
      if (!l.collapsed) l.children.forEach(walk);
    };
    walk(root);
    return map;
  }, [root, leaves, layout, maxX, H]);

  const toggle = (l: L) => { if (!l.children.length) return; setCollapsed((s) => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; }); };
  const lines: ReactElement[] = [], texts: ReactElement[] = [];
  const inHl = (l: L) => hl !== null && (l.id === hl || l.id.startsWith(hl + '.'));
  const walkDraw = (l: L) => {
    const p = pos.get(l.id)!;
    const isLeafLike = !l.children.length || l.collapsed;
    const on = inHl(l), stroke = on ? '#c98a00' : '#231f20', sw = on ? 2.2 : 1.3;
    if (!isLeafLike) {
      const cp = l.children.map((c) => pos.get(c.id)!);
      if (layout === 'circ') {
        const r = p.r!, a0 = Math.min(...l.children.map((c) => pos.get(c.id)!.a!)), a1 = Math.max(...l.children.map((c) => pos.get(c.id)!.a!));
        const [sx, sy, ex, ey] = [W / 2 + r * Math.cos(a0), H / 2 + r * Math.sin(a0), W / 2 + r * Math.cos(a1), H / 2 + r * Math.sin(a1)];
        if (a1 > a0) lines.push(<path key={`a${l.id}`} d={`M${sx},${sy} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${ex},${ey}`} fill="none" stroke={stroke} strokeWidth={sw} />);
        l.children.forEach((c, i) => { const q = cp[i]; const rx = W / 2 + r * Math.cos(q.a!), ry = H / 2 + r * Math.sin(q.a!); lines.push(<line key={`l${c.id}`} x1={rx} y1={ry} x2={q.x} y2={q.y} stroke={inHl(c) ? '#c98a00' : '#231f20'} strokeWidth={inHl(c) ? 2.2 : 1.3} />); });
      } else {
        lines.push(<line key={`v${l.id}`} x1={p.x} x2={p.x} y1={Math.min(...cp.map((q) => q.y))} y2={Math.max(...cp.map((q) => q.y))} stroke={stroke} strokeWidth={sw} />);
        l.children.forEach((c, i) => lines.push(<line key={`h${c.id}`} x1={p.x} x2={cp[i].x} y1={cp[i].y} y2={cp[i].y} stroke={inHl(c) ? '#c98a00' : '#231f20'} strokeWidth={inHl(c) ? 2.2 : 1.3} />));
      }
      if (showSupport && l.node.support !== undefined && l.parent) {
        const s = l.node.support, col = s >= 95 ? '#1d8a57' : s >= 70 ? '#4570b6' : '#b3342a';
        texts.push(<text key={`s${l.id}`} x={p.x + (layout === 'circ' ? 4 : -3)} y={p.y - 4} fontSize="10" fill={col} textAnchor={layout === 'circ' ? 'start' : 'end'} fontWeight={600}>{s}</text>);
      }
      l.children.forEach(walkDraw);
      // clickable node handle
      texts.push(<circle key={`n${l.id}`} cx={p.x} cy={p.y} r={4.5} fill="#fff" stroke="#4570b6" strokeWidth={1.2} style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); if (e.shiftKey) toggle(l); else setHl((h) => (h === l.id ? null : l.id)); }} onDoubleClick={(e) => { e.stopPropagation(); toggle(l); }}><title>{`${l.leaves} taxa${l.node.support !== undefined ? ` · bootstrap ${l.node.support}%` : ''}. Click: highlight clade. Double-click or Shift+click: collapse/expand.`}</title></circle>);
    } else if (l.collapsed) {
      const sz = 11;
      texts.push(<g key={`c${l.id}`} style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); toggle(l); }}><polygon points={layout === 'circ' ? `${p.x},${p.y - sz / 2} ${p.x + sz},${p.y} ${p.x},${p.y + sz / 2}` : `${p.x},${p.y} ${p.x + 26},${p.y - sz} ${p.x + 26},${p.y + sz}`} fill="#caebfb" stroke="#4570b6" /><text x={p.x + (layout === 'circ' ? sz + 4 : 32)} y={p.y + 4} fontSize="12" fill="#231f20">{`${l.leaves} taxa (${l.tips.slice(0, 2).map((t) => (members[t]?.organism ?? t)).join(', ')}${l.tips.length > 2 ? ', …' : ''})`}</text><title>Click to expand</title></g>);
    } else {
      const name = l.node.name ?? '', m = members[name], isQ = name === queryLabel || m?.role === 'query', isOut = m?.role === 'outgroup';
      const anchorRight = layout !== 'circ' || Math.cos(p.a!) >= 0;
      const rot = layout === 'circ' ? (Math.cos(p.a!) >= 0 ? (p.a! * 180) / Math.PI : (p.a! * 180) / Math.PI + 180) : 0;
      const tx = layout === 'circ' ? p.x + Math.cos(p.a!) * 6 : p.x + 6, ty = layout === 'circ' ? p.y + Math.sin(p.a!) * 6 : p.y + 4;
      const txt = label(name);
      texts.push(
        <g key={`t${l.id}`}>
          {isQ && layout !== 'circ' && <rect x={tx - 3} y={p.y - 9} width={Math.min(LABEL - 12, txt.length * 6.6 + 8)} height={18} rx={4} fill="#ffe3a3" />}
          <text x={tx} y={ty} fontSize="12" fill={isOut ? '#6b7078' : '#231f20'} fontWeight={isQ || inHl(l) ? 700 : 400} fontStyle={isOut ? 'italic' : 'normal'} textAnchor={anchorRight ? 'start' : 'end'} transform={layout === 'circ' ? `rotate(${rot} ${tx} ${ty})` : undefined}>{txt}{isQ ? '  ◀ query' : isOut ? '  (outgroup)' : ''}</text>
          <circle cx={p.x} cy={p.y} r={2.5} fill={isQ ? '#c98a00' : isOut ? '#9aa0a8' : '#4570b6'} />
          <title>{`${m?.organism ?? name}${m?.accession ? ' · ' + m.accession : ''}${l.node.length ? `\nbranch length ${l.node.length.toPrecision(3)}` : ''}`}</title>
        </g>);
    }
  };
  walkDraw(root);

  // scale bar (phylogram only)
  const scale = layout === 'rect' ? (() => { const target = maxX / 5; const pow = 10 ** Math.floor(Math.log10(target)); const v = [1, 2, 5].map((m) => m * pow).reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a)); return { v, w: (v / maxX) * (W - LABEL - 20) }; })() : null;

  // zoom & pan
  const onWheel = useCallback((e: WheelEvent) => {
    const svg = svgRef.current; if (!svg) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * H;
    setView((v) => { const k = Math.max(0.4, Math.min(8, v.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); const f = k / v.k; return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f }; });
  }, [H]);
  useEffect(() => { const el = svgRef.current; if (!el) return; el.addEventListener('wheel', onWheel, { passive: false }); return () => el.removeEventListener('wheel', onWheel); }, [onWheel]);
  const onDown = (e: RPointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; (e.target as Element).setPointerCapture?.(e.pointerId); };
  const onMove = (e: RPointerEvent) => { const d = drag.current, svg = svgRef.current; if (!d || !svg) return; const r = svg.getBoundingClientRect(); setView((v) => ({ ...v, x: d.vx + ((e.clientX - d.x) / r.width) * W, y: d.vy + ((e.clientY - d.y) / r.height) * H })); };
  const zoom = (f: number) => setView((v) => { const k = Math.max(0.4, Math.min(8, v.k * f)), g = k / v.k; return { k, x: W / 2 - (W / 2 - v.x) * g, y: H / 2 - (H / 2 - v.y) * g }; });

  const download = useCallback((name: string, blob: Blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }, []);
  const serialize = () => {
    const svg = svgRef.current!.cloneNode(true) as SVGSVGElement;
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); svg.setAttribute('width', String(W)); svg.setAttribute('height', String(H));
    const g = svg.querySelector('g[data-zoom]'); g?.removeAttribute('transform');
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); bg.setAttribute('width', String(W)); bg.setAttribute('height', String(H)); bg.setAttribute('fill', '#fff'); svg.insertBefore(bg, svg.firstChild);
    svg.querySelectorAll('title').forEach((t) => t.remove());
    return new XMLSerializer().serializeToString(svg);
  };
  const exportSvg = () => download(`${filename}.svg`, new Blob([serialize()], { type: 'image/svg+xml' }));
  const exportPng = () => {
    const url = URL.createObjectURL(new Blob([serialize()], { type: 'image/svg+xml' })); const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = W * 2; c.height = H * 2; const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height); c.toBlob((b) => { if (b) download(`${filename}.png`, b); else toast('PNG export failed', 'err'); }); URL.revokeObjectURL(url); };
    img.onerror = () => toast('PNG export failed – use SVG instead', 'err'); img.src = url;
  };
  const allInternal = useMemo(() => { const ids: string[] = []; const walk = (l: L) => { if (l.children.length) { if (l.parent) ids.push(l.id); l.children.forEach(walk); } }; walk(build(tree, 'r', null, new Set(), 0, false)); return ids; }, [tree]);

  return (
    <div className="treewrap">
      <div className="treetools">
        <label className="small row" style={{ gap: 4 }}><Lbl k="treeLayout">Layout</Lbl><select aria-label="Tree layout" className="select" style={{ width: 'auto' }} value={layout} onChange={(e) => { setLayout(e.target.value as LayoutKind); setView({ k: 1, x: 0, y: 0 }); }}><option value="rect">Rectangular (to scale)</option><option value="clado">Cladogram</option><option value="circ">Circular</option></select></label>
        <label className="small row" style={{ gap: 4 }}>Labels<select aria-label="Tip labels" className="select" style={{ width: 'auto' }} value={labelMode} onChange={(e) => setLabelMode(e.target.value as typeof labelMode)}><option value="both">Organism · accession</option><option value="organism">Organism</option><option value="accession">Accession</option></select></label>
        <label className="check small"><input type="checkbox" checked={showSupport} onChange={(e) => setShowSupport(e.target.checked)} /><Lbl k="bootstrapValue">Support values</Lbl></label>
        <span className="grow" />
        <Hint text="Zoom out"><button className="btn secondary sm icon" onClick={() => zoom(1 / 1.25)} aria-label="Zoom out">−</button></Hint>
        <Hint text="Zoom in (or use the mouse wheel; drag to pan)"><button className="btn secondary sm icon" onClick={() => zoom(1.25)} aria-label="Zoom in">+</button></Hint>
        <button className="btn secondary sm" onClick={() => setView({ k: 1, x: 0, y: 0 })}>Fit</button>
        <Hint k="collapseClade"><span className="row"><button className="btn secondary sm" onClick={() => setCollapsed(new Set(allInternal))}>Collapse all</button><button className="btn secondary sm" onClick={() => { setCollapsed(new Set()); setHl(null); }}>Expand all</button></span></Hint>
        <button className="btn secondary sm" onClick={exportSvg}><Icon name="download" /> SVG</button><button className="btn secondary sm" onClick={exportPng}>PNG</button>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ maxHeight: '72vh' }} role="img" aria-label="Phylogenetic tree" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onClick={() => setHl(null)}>
        <g data-zoom="1" transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {lines}{texts}
          {scale && <g transform={`translate(12 ${H - 18})`}><line x1="0" x2={scale.w} y1="0" y2="0" stroke="#231f20" strokeWidth="1.5" /><line x1="0" x2="0" y1="-4" y2="4" stroke="#231f20" /><line x1={scale.w} x2={scale.w} y1="-4" y2="4" stroke="#231f20" /><text x={scale.w + 8} y="4" fontSize="11" fill="#231f20">{`${+scale.v.toPrecision(2)} ${scaleUnit}`}</text></g>}
        </g>
      </svg>
      <div className="small muted" style={{ padding: '4px 10px 8px' }}>Click a node to highlight its clade · double-click (or Shift+click) to collapse/expand · numbers on branches are bootstrap values (<span style={{ color: '#1d8a57' }}>≥95</span>, <span style={{ color: '#4570b6' }}>≥70</span>, <span style={{ color: '#b3342a' }}>&lt;70</span>) <HelpTip k="bootstrapValue" /></div>
    </div>
  );
}
function circMean(a: number[]) { const x = a.reduce((s, v) => s + Math.cos(v), 0), y = a.reduce((s, v) => s + Math.sin(v), 0); let m = Math.atan2(y, x); if (m < 0) m += Math.PI * 2; return m; }
