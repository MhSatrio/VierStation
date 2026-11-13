import { useMemo, useState } from 'react';

// ---------- colour scales (brand-based; sequential for 0..1, diverging for z-scores) ----------
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) => { const A = hex(a), B = hex(b); return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(',')})`; };
export const seqColor = (t: number) => (t <= 0.5 ? mix('#f4f9fd', '#caebfb', t * 2) : t <= 0.8 ? mix('#caebfb', '#4570b6', (t - 0.5) / 0.3) : mix('#4570b6', '#231f20', (t - 0.8) / 0.2));
export const divColor = (t: number) => (t < 0 ? mix('#ffffff', '#4570b6', Math.min(1, -t)) : mix('#ffffff', '#c98a00', Math.min(1, t)));
const textOn = (bg: string) => { const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(bg); if (!m) return '#231f20'; return 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3] < 140 ? '#fff' : '#231f20'; };

/** Labelled matrix heat map (SVG). `diverging` centres the scale at 0 (for z-scores / correlations). */
export function HeatMap({ rows, cols, values, diverging, min, max, cell = 22, showValues, title, rowOrder, colOrder }: {
  rows: string[]; cols: string[]; values: (number | null)[][]; diverging?: boolean; min?: number; max?: number; cell?: number; showValues?: boolean; title?: string; rowOrder?: number[]; colOrder?: number[];
}) {
  const ro = rowOrder ?? rows.map((_, i) => i), co = colOrder ?? cols.map((_, i) => i);
  const flat = values.flat().filter((x): x is number => x !== null);
  const lo = min ?? (flat.length ? Math.min(...flat) : 0), hi = max ?? (flat.length ? Math.max(...flat) : 1);
  const absMax = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
  const lw = Math.min(180, Math.max(60, Math.max(...rows.map((r) => r.length)) * 6.4)), th = Math.min(120, Math.max(40, Math.max(...cols.map((c) => c.length)) * 6));
  const W = lw + co.length * cell + 90, H = th + ro.length * cell + 10;
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  return (
    <div style={{ overflow: 'auto', maxWidth: '100%' }}>
      <svg width={W} height={H} role="img" aria-label={title ?? 'Heat map'} style={{ display: 'block' }}>
        {co.map((c, j) => <text key={c} transform={`translate(${lw + j * cell + cell / 2 + 3},${th - 4}) rotate(-60)`} fontSize="11" fill="#231f20">{cols[c].length > 18 ? cols[c].slice(0, 17) + '…' : cols[c]}</text>)}
        {ro.map((r, i) => <text key={r} x={lw - 6} y={th + i * cell + cell / 2 + 4} textAnchor="end" fontSize="11" fill="#231f20">{rows[r].length > 26 ? rows[r].slice(0, 25) + '…' : rows[r]}</text>)}
        {ro.map((r, i) => co.map((c, j) => {
          const v = values[r]?.[c];
          const fill = v === null || v === undefined ? '#eceef1' : diverging ? divColor(v / absMax) : seqColor((v - lo) / (hi - lo || 1));
          return (
            <g key={`${r}-${c}`} onMouseEnter={() => setHover({ r, c })} onMouseLeave={() => setHover(null)}>
              <rect x={lw + j * cell} y={th + i * cell} width={cell - 1} height={cell - 1} fill={fill} rx="2"><title>{`${rows[r]} × ${cols[c]}: ${v ?? 'missing'}`}</title></rect>
              {showValues && v !== null && v !== undefined && cell >= 28 && <text x={lw + j * cell + cell / 2} y={th + i * cell + cell / 2 + 3} textAnchor="middle" fontSize="9.5" fill={textOn(fill)}>{Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(2)}</text>}
            </g>
          );
        }))}
        {[0, 0.25, 0.5, 0.75, 1].map((t, k) => <rect key={k} x={lw + co.length * cell + 18} y={th + k * 12} width="14" height="12" fill={diverging ? divColor((t * 2 - 1)) : seqColor(t)} />)}
        <text x={lw + co.length * cell + 36} y={th + 9} fontSize="10" fill="#565a60">{diverging ? `+${absMax.toFixed(1)}` : hi.toFixed(2)}</text>
        <text x={lw + co.length * cell + 36} y={th + 62} fontSize="10" fill="#565a60">{diverging ? `−${absMax.toFixed(1)}` : lo.toFixed(2)}</text>
      </svg>
      <div className="small muted" style={{ minHeight: 18 }}>{hover ? `${rows[hover.r]} × ${cols[hover.c]} = ${values[hover.r]?.[hover.c] ?? 'missing'}` : ''}</div>
    </div>
  );
}

// ---------- alignment ----------
const BLOCK = 60;
export function AlignmentView({ labels, rows, consensus, conservation }: { labels: string[]; rows: string[]; consensus?: string; conservation?: number[] }) {
  const L = rows[0]?.length ?? 0;
  const blocks = Math.ceil(L / BLOCK);
  const out = [];
  for (let b = 0; b < blocks; b++) {
    const s = b * BLOCK, e = Math.min(L, s + BLOCK);
    out.push(
      <div key={b} style={{ marginBottom: 12 }}>
        <div className="aln"><span className="lbl" />{Array.from({ length: e - s }, (_, i) => ((s + i + 1) % 10 === 0 ? String((s + i + 1) % 100 === 0 ? s + i + 1 : (s + i + 1)).slice(-1) : ' ')).join('')}</div>
        {rows.map((r, k) => (
          <div key={k} className="aln"><span className="lbl" title={labels[k]}>{labels[k]}</span>{r.slice(s, e).split('').map((ch, i) => <span key={i} className={`res ${ch === '-' ? 'g' : consensus && consensus[s + i] === ch ? 'm' : 'x'}`}>{ch}</span>)}</div>
        ))}
        {consensus && <div className="aln" style={{ fontWeight: 600 }}><span className="lbl">consensus</span>{consensus.slice(s, e)}</div>}
        {conservation && <div className="aln"><span className="lbl">conservation</span>{conservation.slice(s, e).map((c, i) => <span key={i} className="res" title={`${Math.round(c * 100)}%`} style={{ display: 'inline-block', height: 10, background: seqColor(c), marginRight: 0 }} />)}</div>}
      </div>,
    );
  }
  return <div style={{ overflowX: 'auto' }} role="img" aria-label={`Multiple alignment of ${rows.length} sequences, ${L} columns`}>{out}</div>;
}

export function PairwiseView({ a, b, labels }: { a: string; b: string; labels: [string, string] }) {
  const rows: string[] = [a, b];
  const mid = a.split('').map((ch, i) => (ch === '-' || b[i] === '-' ? ' ' : ch === b[i] ? '|' : '.')).join('');
  const L = a.length, blocks = Math.ceil(L / BLOCK);
  return (
    <div style={{ overflowX: 'auto' }}>
      {Array.from({ length: blocks }, (_, k) => { const s = k * BLOCK, e = Math.min(L, s + BLOCK); return (
        <div key={k} style={{ marginBottom: 12 }}>
          <div className="aln"><span className="lbl" title={labels[0]}>{labels[0]}</span>{rows[0].slice(s, e)}</div>
          <div className="aln"><span className="lbl" />{mid.slice(s, e)}</div>
          <div className="aln"><span className="lbl" title={labels[1]}>{labels[1]}</span>{rows[1].slice(s, e)}</div>
        </div>); })}
    </div>
  );
}

// ---------- phylogenetic tree ----------
interface TNode { id: number; name?: string; length: number; children?: TNode[] }
export function TreeView({ tree }: { tree: TNode }) {
  const layout = useMemo(() => {
    let leaf = 0;
    const nodes: { x: number; y: number; n: TNode; px?: number; py?: number }[] = [];
    const maxX = { v: 0 };
    const rec = (n: TNode, x: number, parent?: { x: number; y: number }): { y: number } => {
      const nx = x + (parent ? n.length : 0);
      maxX.v = Math.max(maxX.v, nx);
      let y: number;
      if (!n.children) y = leaf++;
      else { const ys = n.children.map((c) => rec(c, nx, { x: nx, y: 0 }).y); y = (Math.min(...ys) + Math.max(...ys)) / 2; }
      nodes.push({ x: nx, y, n, px: parent?.x });
      return { y };
    };
    rec(tree, 0);
    return { nodes, leaves: leaf, maxX: maxX.v || 1 };
  }, [tree]);
  const W = 640, rowH = 22, pad = 160, H = layout.leaves * rowH + 40;
  const sx = (x: number) => 10 + (x / layout.maxX) * (W - pad - 10);
  const sy = (y: number) => 14 + y * rowH;
  const kids = (n: TNode) => (n.children ?? []).map((c) => layout.nodes.find((q) => q.n === c)!);
  return (
    <div style={{ overflow: 'auto' }}>
      <svg width={W} height={H} role="img" aria-label="Phylogenetic tree">
        {layout.nodes.map((q) => (
          <g key={q.n.id}>
            {q.px !== undefined && <line x1={sx(q.px)} x2={sx(q.x)} y1={sy(q.y)} y2={sy(q.y)} stroke="#4570b6" strokeWidth="1.6" />}
            {q.n.children && (() => { const ys = kids(q.n).map((k) => k.y); return <line x1={sx(q.x)} x2={sx(q.x)} y1={sy(Math.min(...ys))} y2={sy(Math.max(...ys))} stroke="#4570b6" strokeWidth="1.6" />; })()}
            {!q.n.children && <text x={sx(q.x) + 6} y={sy(q.y) + 4} fontSize="12" fill="#231f20">{q.n.name}</text>}
          </g>
        ))}
        <g transform={`translate(10 ${H - 14})`}><line x1="0" x2={(layout.maxX / 5 / layout.maxX) * (W - pad - 10)} y1="0" y2="0" stroke="#231f20" /><text x="0" y="-4" fontSize="10.5" fill="#565a60">{(layout.maxX / 5).toPrecision(2)} substitutions/site</text></g>
      </svg>
    </div>
  );
}

// ---------- PCA ----------
export function PcaPlot({ scores, labels, explained, groups, groupName }: { scores: number[][]; labels: string[]; explained: number[]; groups: (string | null)[] | null; groupName: string | null }) {
  const [px, setPx] = useState(0), [py, setPy] = useState(Math.min(1, explained.length - 1));
  const W = 560, H = 400, m = 46;
  const xs = scores.map((s) => s[px]), ys = scores.map((s) => s[py]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)], [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const padx = (x1 - x0) * 0.08 || 1, pady = (y1 - y0) * 0.08 || 1;
  const X = (v: number) => m + ((v - x0 + padx) / (x1 - x0 + 2 * padx)) * (W - m - 10), Y = (v: number) => H - m - ((v - y0 + pady) / (y1 - y0 + 2 * pady)) * (H - m - 10);
  const levels = groups ? [...new Set(groups.filter((g): g is string => g !== null))] : [];
  const pal = ['#4570b6', '#c98a00', '#1d8a57', '#8a56c2', '#b3342a', '#2f8f9d', '#231f20'];
  const col = (i: number) => (groups && groups[i] ? pal[levels.indexOf(groups[i]!) % pal.length] : '#4570b6');
  return (
    <div className="col">
      <div className="row wrap"><label className="field">X axis<select className="select" value={px} onChange={(e) => setPx(+e.target.value)}>{explained.map((_, i) => <option key={i} value={i}>PC{i + 1} ({(explained[i] * 100).toFixed(1)}%)</option>)}</select></label>
        <label className="field">Y axis<select className="select" value={py} onChange={(e) => setPy(+e.target.value)}>{explained.map((_, i) => <option key={i} value={i}>PC{i + 1} ({(explained[i] * 100).toFixed(1)}%)</option>)}</select></label></div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W }} role="img" aria-label="PCA scatter plot">
        <rect x={m} y="10" width={W - m - 10} height={H - m - 10} fill="#fff" stroke="rgb(35 31 32 / .2)" />
        {x0 < 0 && x1 > 0 && <line x1={X(0)} x2={X(0)} y1="10" y2={H - m} stroke="rgb(35 31 32 / .15)" strokeDasharray="4 3" />}
        {y0 < 0 && y1 > 0 && <line y1={Y(0)} y2={Y(0)} x1={m} x2={W - 10} stroke="rgb(35 31 32 / .15)" strokeDasharray="4 3" />}
        {scores.map((s, i) => <g key={i}><circle cx={X(s[px])} cy={Y(s[py])} r="5.5" fill={col(i)} fillOpacity="0.85" stroke="#fff"><title>{`${labels[i]}  PC${px + 1}=${s[px]}  PC${py + 1}=${s[py]}`}</title></circle>{scores.length <= 30 && <text x={X(s[px]) + 8} y={Y(s[py]) + 4} fontSize="10.5" fill="#231f20">{labels[i]}</text>}</g>)}
        <text x={(W + m) / 2} y={H - 8} textAnchor="middle" fontSize="12">PC{px + 1} ({(explained[px] * 100).toFixed(1)}%)</text>
        <text transform={`translate(14 ${H / 2}) rotate(-90)`} textAnchor="middle" fontSize="12">PC{py + 1} ({(explained[py] * 100).toFixed(1)}%)</text>
      </svg>
      {levels.length > 0 && <div className="row wrap small">{groupName}: {levels.map((l, i) => <span key={l}><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: pal[i % pal.length], marginRight: 4 }} />{l}</span>)}</div>}
      <div className="row" style={{ alignItems: 'flex-end', gap: 4, height: 70 }} aria-label="Variance explained per component">{explained.map((e, i) => <div key={i} style={{ textAlign: 'center' }}><div style={{ width: 34, height: Math.max(2, e * 56), background: '#4570b6', borderRadius: 3 }} title={`${(e * 100).toFixed(1)}%`} /><div className="small muted">PC{i + 1}</div></div>)}</div>
    </div>
  );
}
