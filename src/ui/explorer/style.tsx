// Visual language of the explorer: one blue family (VierApparatus #4570B6 … #CAEBFB). Entity type = SHAPE + a short marker letter inside the node;
// evidence = line STYLE (solid / dashed / dotted) + width + a text label; selection = thick border + halo. Colour is never the only signal.
import { BLUE, EDGE_STYLE, NODE_TYPES } from '../../../shared/graph.ts';
import type { NodeTypeId } from '../../../shared/graph.ts';

export const MARKER: Record<NodeTypeId, string> = { dna: 'DNA', rna: 'RNA', gene: 'G', protein: 'P', enzyme: 'E', chemical: 'C', metabolite: 'M', reaction: 'R', pathway: 'Pw', organism: 'Org', publication: 'Pub', structure: '3D' };
export const typeInfo = (id: string) => NODE_TYPES.find((t) => t.id === id) ?? NODE_TYPES[5];

const markerSvg = (t: NodeTypeId) => {
  const c = BLUE[t]; const s = MARKER[t];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><text x="24" y="29" font-family="Jost, Arial, sans-serif" font-size="${s.length > 2 ? 12 : 16}" font-weight="700" text-anchor="middle" fill="${c.text}">${s}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

/** Cytoscape stylesheet. Typed loosely: the typings do not cover every property (underlay-*, text-wrap …). */
export function stylesheet(): any[] {
  const s: any[] = [
    { selector: 'node', style: { label: 'data(label)', 'font-family': 'Jost, Arial, sans-serif', 'font-size': 11, color: '#14295A', 'text-valign': 'bottom', 'text-halign': 'center', 'text-margin-y': 5, 'text-wrap': 'ellipsis', 'text-max-width': 112, 'text-outline-color': '#FFFFFF', 'text-outline-width': 3, 'min-zoomed-font-size': 7, width: 'mapData(degree, 0, 14, 34, 58)', height: 'mapData(degree, 0, 14, 34, 58)', 'border-width': 2, 'background-fit': 'contain', 'background-clip': 'none', 'background-width': '70%', 'background-height': '70%', 'z-index': 10 } },
    { selector: 'node:selected', style: { 'border-width': 5, 'border-color': '#0B1733', 'underlay-color': '#CAEBFB', 'underlay-opacity': 0.95, 'underlay-padding': 8, 'underlay-shape': 'ellipse' } },
    { selector: 'node.hit', style: { 'underlay-color': '#CAEBFB', 'underlay-opacity': 0.95, 'underlay-padding': 7, 'border-width': 4 } },
    { selector: 'node.faded, edge.faded', style: { opacity: 0.22 } },
    { selector: 'node[more > 0]', style: { 'border-style': 'double', 'border-width': 4 } },
    { selector: 'node.ghost', style: { width: 6, height: 6, opacity: 0.0, label: '', events: 'no' } },
    { selector: 'edge', style: { width: 'data(width)', 'line-color': 'data(color)', 'line-style': 'data(line)', 'curve-style': 'bezier', 'control-point-step-size': 34, opacity: 0.92, label: 'data(elabel)', 'font-size': 9, 'font-family': 'Jost, Arial, sans-serif', color: '#14295A', 'text-rotation': 'autorotate', 'text-background-color': '#FFFFFF', 'text-background-opacity': 0.88, 'text-background-padding': 2, 'min-zoomed-font-size': 9, 'target-arrow-color': 'data(color)', 'target-arrow-shape': 'none', 'arrow-scale': 1.1, 'z-index': 5 } },
    { selector: 'edge[?directional]', style: { 'target-arrow-shape': 'triangle' } },
    { selector: 'edge[origin = "order"]', style: { 'curve-style': 'straight', width: 4, 'line-color': '#14295A', 'target-arrow-color': '#14295A', 'target-arrow-shape': 'triangle', 'arrow-scale': 1.5, 'z-index': 20, opacity: 1 } },
    { selector: 'edge[role = "inhibitor"]', style: { 'target-arrow-shape': 'tee' } },
    { selector: 'edge:selected', style: { width: 5, 'line-color': '#0B1733', 'target-arrow-color': '#0B1733', 'underlay-color': '#CAEBFB', 'underlay-opacity': 0.9, 'underlay-padding': 5 } },
    { selector: 'edge.ghostEdge', style: { 'line-style': 'dashed', 'line-color': '#4570B6', width: 2.4, 'target-arrow-shape': 'triangle', 'target-arrow-color': '#4570B6', label: '', events: 'no', opacity: 0.85 } },
    { selector: 'node.dropok', style: { 'underlay-color': '#CAEBFB', 'underlay-opacity': 1, 'underlay-padding': 10, 'border-width': 5, 'border-color': '#4570B6' } },
  ];
  for (const t of NODE_TYPES) {
    const c = BLUE[t.id];
    s.push({ selector: `node[type = "${t.id}"]`, style: { shape: t.shape, 'background-color': c.fill, 'border-color': c.border, 'background-image': markerSvg(t.id), ...(t.id === 'reaction' ? { 'border-width': 3 } : {}), ...(t.id === 'pathway' ? { 'border-width': 3, 'border-style': 'solid' } : {}) } });
  }
  s.push({ selector: 'node:parent', style: { shape: 'round-rectangle', 'background-color': '#F3F8FD', 'background-opacity': 0.55, 'border-color': '#14295A', 'border-width': 2.5, 'text-valign': 'top', 'text-margin-y': -4, 'font-weight': 700, padding: '28px', 'background-image': 'none' } }); // last, so a pathway container never shows the pathway marker or a shape fill
  return s;
}

/** edge → Cytoscape data (the label always names the evidence class, so the line style and colour are never the only cue) */
export function edgeData(e: any) {
  const st = e.origin === 'participant' || e.origin === 'step' || e.origin === 'order' ? { color: '#2B4F8C', width: e.origin === 'order' ? 3 : 2, line: e.style === 'dashed' ? 'dashed' : e.style === 'dotted' ? 'dotted' : 'solid' } : EDGE_STYLE[e.evidence] ?? EDGE_STYLE.unverified;
  const tag = e.origin === 'relationship' || e.origin === 'field' ? ` · ${(EDGE_STYLE[e.evidence] ?? EDGE_STYLE.unverified).short}` : ''; // the evidence is always written on the line, so colour and dash are never the only cue
  return { id: e.id, source: e.source, target: e.target, elabel: `${e.label}${tag}`, color: st.color, width: st.width, line: st.line, directional: e.directional, role: e.role ?? '', origin: e.origin, evidence: e.evidence, predicted: e.predicted, typeName: e.typeName, tags: e.tags, citations: e.citations, description: e.description };
}

/** Small SVG glyph of a node shape, for legends and filter chips (same shape language as the canvas). */
export function ShapeGlyph({ type, size = 20 }: { type: string; size?: number }) {
  const t = typeInfo(type); const c = BLUE[t.id]; const common = { fill: c.fill, stroke: c.border, strokeWidth: 1.6 };
  const shape = (() => {
    switch (t.shape) {
      case 'ellipse': return <ellipse cx="12" cy="12" rx="9.5" ry="9.5" {...common} />;
      case 'round-rectangle': return <rect x="3" y="5" width="18" height="14" rx="4" {...common} />;
      case 'rectangle': return <rect x="3.5" y="5.5" width="17" height="13" {...common} />;
      case 'cut-rectangle': return <polygon points="6,4 18,4 21,7 21,17 18,20 6,20 3,17 3,7" {...common} />;
      case 'hexagon': return <polygon points="12,3 20,7.5 20,16.5 12,21 4,16.5 4,7.5" {...common} />;
      case 'octagon': return <polygon points="8,3 16,3 21,8 21,16 16,21 8,21 3,16 3,8" {...common} />;
      case 'triangle': return <polygon points="12,3.5 21,20 3,20" {...common} />;
      case 'pentagon': return <polygon points="12,3 21,10 17.500,21 6.500,21 3,10" {...common} />;
      case 'diamond': return <polygon points="12,2.500 21.500,12 12,21.500 2.500,12" {...common} />;
      case 'tag': return <polygon points="3,5 16,5 21,12 16,19 3,19" {...common} />;
      case 'barrel': return <><rect x="4" y="5" width="16" height="14" rx="7" {...common} /><path d="M4.500 9.500h15M4.500 14.500h15" stroke={c.border} strokeWidth="1" fill="none" /></>;
      default: return <circle cx="12" cy="12" r="9" {...common} />;
    }
  })();
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none' }}>{shape}</svg>;
}

export function LineGlyph({ ev }: { ev: string }) {
  const st = EDGE_STYLE[ev] ?? EDGE_STYLE.unverified;
  return <svg width="34" height="10" viewBox="0 0 34 10" aria-hidden="true" style={{ flex: 'none' }}><line x1="1" y1="5" x2="33" y2="5" stroke={st.color} strokeWidth={st.width} strokeDasharray={st.line === 'dashed' ? '7 4' : st.line === 'dotted' ? '1.5 3.5' : undefined} strokeLinecap={st.line === 'dotted' ? 'round' : 'butt'} /></svg>;
}
