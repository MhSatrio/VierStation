// Rectangular phylogram layout shared by the PDF report and the standalone SVG export. Output is a list of drawing primitives; nothing here guesses data:
// branch lengths and support values come straight from the stored tree.
import type { Nested } from '../phylo/tree.ts';

export type DrawItem =
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number; w: number; c: string }
  | { k: 'text'; x: number; y: number; s: string; size: number; bold?: boolean; c: string; anchor?: 'start' | 'middle' | 'end' };
export interface TreeFigure { w: number; h: number; items: DrawItem[]; leaves: number; hasLengths: boolean; scaleBar: { length: number; label: string } | null }
export interface LeafLook { text: string; role: 'query' | 'ingroup' | 'outgroup' | 'other' }
export const TREE_COLORS = { branch: '#231F20', query: '#4570B6', outgroup: '#6B6B6B', support: '#6B6B6B', ingroup: '#231F20' };

const nice = (x: number) => { const p = 10 ** Math.floor(Math.log10(x)); const m = x / p; return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p; };

export function layoutTree(tree: Nested, look: (name: string) => LeafLook, o: { width: number; rowH?: number; fontSize?: number; measure: (s: string, size: number, bold: boolean) => number; supportMin?: number }): TreeFigure {
  const rowH = o.rowH ?? 16, fs = o.fontSize ?? 9, pad = 6;
  const leaves: Nested[] = [];
  const collect = (n: Nested) => { if (n.children?.length) n.children.forEach(collect); else leaves.push(n); };
  collect(tree);
  const hasLengths = (() => { let any = false; const walk = (n: Nested, root: boolean) => { if (!root && n.length > 1e-9) any = true; n.children?.forEach((c) => walk(c, false)); }; walk(tree, true); return any; })();
  const depthOf = new Map<Nested, number>(), yOf = new Map<Nested, number>();
  let maxD = 0;
  const walkD = (n: Nested, d: number) => { depthOf.set(n, d); maxD = Math.max(maxD, d); n.children?.forEach((c) => walkD(c, d + (hasLengths ? Math.max(0, c.length) : 1))); };
  walkD(tree, 0);
  let row = 0;
  const walkY = (n: Nested): number => {
    if (!n.children?.length) { const y = 10 + row * rowH + rowH / 2; row++; yOf.set(n, y); return y; }
    const ys = n.children.map(walkY); const y = (Math.min(...ys) + Math.max(...ys)) / 2; yOf.set(n, y); return y;
  };
  walkY(tree);
  const looks = leaves.map((l) => look(l.name ?? ''));
  const labelW = Math.max(...looks.map((l, i) => o.measure(l.text, fs, l.role === 'query') + (l.role === 'outgroup' ? 0 : 0))) + 10;
  const plotW = Math.max(60, o.width - labelW - 2 * pad), scale = maxD > 0 ? plotW / maxD : 0;
  const X = (n: Nested) => pad + (depthOf.get(n) ?? 0) * scale;
  const items: DrawItem[] = [];
  const draw = (n: Nested, parent?: Nested) => {
    const x = X(n), y = yOf.get(n)!;
    if (parent) items.push({ k: 'line', x1: X(parent), y1: y, x2: x, y2: y, w: 1.1, c: TREE_COLORS.branch });
    if (n.children?.length) {
      const ys = n.children.map((c) => yOf.get(c)!);
      items.push({ k: 'line', x1: x, y1: Math.min(...ys), x2: x, y2: Math.max(...ys), w: 1.1, c: TREE_COLORS.branch });
      if (parent && n.support !== undefined && n.support >= (o.supportMin ?? 0)) items.push({ k: 'text', x: x - 2, y: y - 2.5, s: String(Math.round(n.support)), size: fs - 2, c: TREE_COLORS.support, anchor: 'end' });
      n.children.forEach((c) => draw(c, n));
    } else {
      const lk = look(n.name ?? '');
      items.push({ k: 'text', x: x + 5, y: y + fs * 0.35, s: lk.text, size: fs, bold: lk.role === 'query', c: lk.role === 'query' ? TREE_COLORS.query : lk.role === 'outgroup' ? TREE_COLORS.outgroup : TREE_COLORS.ingroup });
    }
  };
  draw(tree);
  let h = 10 + leaves.length * rowH + 8, scaleBar: TreeFigure['scaleBar'] = null;
  if (hasLengths && scale > 0) {
    const len = nice(maxD * 0.25), sx = pad, sy = h + 6;
    items.push({ k: 'line', x1: sx, y1: sy, x2: sx + len * scale, y2: sy, w: 1.2, c: TREE_COLORS.branch }, { k: 'line', x1: sx, y1: sy - 3, x2: sx, y2: sy + 3, w: 1, c: TREE_COLORS.branch }, { k: 'line', x1: sx + len * scale, y1: sy - 3, x2: sx + len * scale, y2: sy + 3, w: 1, c: TREE_COLORS.branch },
      { k: 'text', x: sx + len * scale + 6, y: sy + 3, s: `${len} substitutions per site`, size: fs - 1, c: TREE_COLORS.support });
    scaleBar = { length: len, label: `${len} substitutions per site` }; h += 16;
  }
  return { w: o.width, h, items, leaves: leaves.length, hasLengths, scaleBar };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function figureToSvg(f: TreeFigure, o: { title?: string; font?: string } = {}): string {
  const font = o.font ?? "Jost, 'Helvetica Neue', Arial, sans-serif";
  const body = f.items.map((i) => i.k === 'line'
    ? `<line x1="${i.x1.toFixed(1)}" y1="${i.y1.toFixed(1)}" x2="${i.x2.toFixed(1)}" y2="${i.y2.toFixed(1)}" stroke="${i.c}" stroke-width="${i.w}" stroke-linecap="square"/>`
    : `<text x="${i.x.toFixed(1)}" y="${i.y.toFixed(1)}" font-size="${i.size}" fill="${i.c}"${i.bold ? ' font-weight="600"' : ''}${i.anchor && i.anchor !== 'start' ? ` text-anchor="${i.anchor}"` : ''}>${esc(i.s)}</text>`).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.w} ${f.h}" width="${f.w}" height="${f.h}" font-family="${font}" role="img"${o.title ? ` aria-label="${esc(o.title)}"` : ''}>\n  <rect width="100%" height="100%" fill="#ffffff"/>\n  ${body}\n</svg>\n`;
}
