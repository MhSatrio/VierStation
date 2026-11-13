// A small, dependency-free PDF writer used for the Sequence Lab report.
//   • text in the brand font Jost (the real TrueType outlines from @fontsource/jost, converted from WOFF and embedded) with a Helvetica fallback
//   • vector drawing (lines, rectangles, SVG paths such as the real VierApparatus icon), page header/footer, wrapped paragraphs and tables with repeating headers
// Coordinates are in points with the origin at the TOP-LEFT of the page (y grows downwards); the writer flips them.
import { deflateSync, inflateSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type RGB = [number, number, number];
export const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
export const BRAND = { blue: hex('#4570B6'), light: hex('#CAEBFB'), ink: hex('#231F20'), grey: hex('#6B6B6B'), line: hex('#D5DCE6'), warn: hex('#B45309'), white: [1, 1, 1] as RGB };

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

// ---------------------------------------------------------------- text normalisation (glyphs Jost / WinAnsi do not have)
const FALLBACK: Record<string, string> = { '′': "'", '″': '"', '≥': '>=', '≤': '<=', '→': '->', '←': '<-', '≈': '~', 'Δ': 'Delta', '✓': 'ok', '⚠': '!', '−': '-', ' ': ' ', ' ': ' ', ' ': ' ', '≠': '!=', '×': 'x', 'γ': 'gamma', 'Γ': 'Gamma', 'α': 'alpha', 'β': 'beta', '≪': '<<', '‑': '-', '↔': '<->', '∞': 'inf', '²': '2', '₂': '2' };
export const normalise = (s: string) => s.replace(/[^\x00-\x7e]/gu, (c) => FALLBACK[c] ?? c);

// ---------------------------------------------------------------- fonts
export interface PdfFont {
  id: string; width(s: string, size: number): number;
  /** the PDF string operand for s (hex or literal) */
  encode(s: string): string; lineHeight: number;
  emit(w: ObjWriter): number; // writes the font objects, returns the id of the font dictionary
}
export interface ObjWriter { alloc(): number; set(id: number, body: string | Buffer): void; stream(dict: string, data: Buffer, compress?: boolean): Buffer }

const HELV = '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584'.split(' ').map(Number);
const HELV_B = '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584'.split(' ').map(Number);

class StandardFont implements PdfFont {
  lineHeight = 1.25; id: string; private base: string; private widths: number[] | null;
  constructor(id: string, base: string, widths: number[] | null) { this.id = id; this.base = base; this.widths = widths; }
  private clean(s: string) { return normalise(s).replace(/[^\x20-\xff]/g, '?'); }
  width(s: string, size: number) { let w = 0; for (const c of this.clean(s)) { const k = c.charCodeAt(0); w += this.widths ? (k >= 32 && k <= 126 ? this.widths[k - 32] : 556) : 600; } return (w * size) / 1000; }
  encode(s: string) { return '(' + this.clean(s).replace(/([\\()])/g, '\\$1') + ')'; }
  emit(w: ObjWriter) { const id = w.alloc(); w.set(id, `<< /Type /Font /Subtype /Type1 /BaseFont /${this.base} /Encoding /WinAnsiEncoding >>`); return id; }
}

/** WOFF (version 1) → plain TrueType (sfnt) by inflating each table. */
export function woffToSfnt(buf: Buffer): Buffer {
  if (buf.toString('latin1', 0, 4) !== 'wOFF') throw new Error('not a WOFF file');
  const flavor = buf.readUInt32BE(4), n = buf.readUInt16BE(12);
  const tabs: { tag: string; data: Buffer; sum: number }[] = [];
  for (let i = 0; i < n; i++) {
    const o = 44 + 20 * i, off = buf.readUInt32BE(o + 4), comp = buf.readUInt32BE(o + 8), orig = buf.readUInt32BE(o + 12);
    const raw = buf.subarray(off, off + comp);
    tabs.push({ tag: buf.toString('latin1', o, o + 4), data: comp < orig ? inflateSync(raw) : raw, sum: buf.readUInt32BE(o + 16) });
  }
  let sel = 0; while (2 ** (sel + 1) <= n) sel++;
  const sr = 2 ** sel * 16, head = Buffer.alloc(12 + 16 * n);
  head.writeUInt32BE(flavor, 0); head.writeUInt16BE(n, 4); head.writeUInt16BE(sr, 6); head.writeUInt16BE(sel, 8); head.writeUInt16BE(n * 16 - sr, 10);
  let off = head.length; const parts: Buffer[] = [head];
  tabs.forEach((t, i) => {
    const o = 12 + 16 * i; head.write(t.tag, o, 'latin1'); head.writeUInt32BE(t.sum, o + 4); head.writeUInt32BE(off, o + 8); head.writeUInt32BE(t.data.length, o + 12);
    const pad = (4 - (t.data.length % 4)) % 4; parts.push(t.data, Buffer.alloc(pad)); off += t.data.length + pad;
  });
  return Buffer.concat(parts);
}

class TtfFont implements PdfFont {
  lineHeight = 1.3;
  private used = new Map<number, number>(); // glyph id -> code point
  private cmap = new Map<number, number>();
  private adv: number[] = []; private upem = 1000; private bbox = [0, 0, 1000, 1000]; private asc = 900; private desc = -250; private cap = 700;
  id: string; private name: string; private sfnt: Buffer;
  constructor(id: string, name: string, sfnt: Buffer) {
    this.id = id; this.name = name; this.sfnt = sfnt;
    const tb = new Map<string, Buffer>(); const n = sfnt.readUInt16BE(4);
    for (let i = 0; i < n; i++) { const o = 12 + 16 * i; tb.set(sfnt.toString('latin1', o, o + 4), sfnt.subarray(sfnt.readUInt32BE(o + 8), sfnt.readUInt32BE(o + 8) + sfnt.readUInt32BE(o + 12))); }
    const head = tb.get('head')!, hhea = tb.get('hhea')!, hmtx = tb.get('hmtx')!, maxp = tb.get('maxp')!, cm = tb.get('cmap')!, os2 = tb.get('OS/2');
    this.upem = head.readUInt16BE(18); this.bbox = [head.readInt16BE(36), head.readInt16BE(38), head.readInt16BE(40), head.readInt16BE(42)];
    this.asc = hhea.readInt16BE(4); this.desc = hhea.readInt16BE(6); if (os2 && os2.length > 90 && os2.readUInt16BE(0) >= 2) this.cap = os2.readInt16BE(88) || this.cap;
    const nh = hhea.readUInt16BE(34), ng = maxp.readUInt16BE(4);
    for (let g = 0; g < ng; g++) this.adv.push(hmtx.readUInt16BE(Math.min(g, nh - 1) * 4));
    // cmap format 4 (BMP)
    const nt = cm.readUInt16BE(2); let sub = -1;
    for (let i = 0; i < nt; i++) { const p = cm.readUInt16BE(4 + 8 * i), e = cm.readUInt16BE(6 + 8 * i), off = cm.readUInt32BE(8 + 8 * i); if ((p === 3 && e === 1) || (p === 0 && cm.readUInt16BE(off) === 4)) { sub = off; if (p === 3) break; } }
    if (sub < 0) throw new Error('font has no BMP cmap');
    const segX2 = cm.readUInt16BE(sub + 6), segs = segX2 / 2, endO = sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    for (let s = 0; s < segs; s++) {
      const end = cm.readUInt16BE(endO + 2 * s), start = cm.readUInt16BE(startO + 2 * s), delta = cm.readInt16BE(deltaO + 2 * s), ro = cm.readUInt16BE(rangeO + 2 * s);
      for (let c = start; c <= end && c < 0xffff; c++) {
        let g: number;
        if (ro === 0) g = (c + delta) & 0xffff; else { const gi = cm.readUInt16BE(rangeO + 2 * s + ro + 2 * (c - start)); g = gi === 0 ? 0 : (gi + delta) & 0xffff; }
        if (g) this.cmap.set(c, g);
      }
    }
  }
  private glyphs(s: string): number[] {
    return [...normalise(s)].map((ch) => { const cp = ch.codePointAt(0)!; const g = this.cmap.get(cp) ?? this.cmap.get(63) ?? 0; this.used.set(g, this.cmap.has(cp) ? cp : 63); return g; });
  }
  width(s: string, size: number) { let w = 0; for (const ch of normalise(s)) w += this.adv[this.cmap.get(ch.codePointAt(0)!) ?? this.cmap.get(63) ?? 0] ?? 500; return (w * size) / this.upem; }
  encode(s: string) { return '<' + this.glyphs(s).map((g) => g.toString(16).padStart(4, '0')).join('') + '>'; }
  emit(w: ObjWriter) {
    const sc = 1000 / this.upem, ff = w.alloc(), fd = w.alloc(), cid = w.alloc(), t0 = w.alloc(), tu = w.alloc();
    w.set(ff, w.stream(`/Length1 ${this.sfnt.length}`, this.sfnt));
    w.set(fd, `<< /Type /FontDescriptor /FontName /${this.name} /Flags 32 /FontBBox [${this.bbox.map((x) => Math.round(x * sc)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(this.asc * sc)} /Descent ${Math.round(this.desc * sc)} /CapHeight ${Math.round(this.cap * sc)} /StemV 80 /FontFile2 ${ff} 0 R >>`);
    const gids = [...this.used.keys()].sort((a, b) => a - b);
    w.set(cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${this.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${fd} 0 R /CIDToGIDMap /Identity /DW ${Math.round(500 * sc)} /W [${gids.map((g) => `${g} [${Math.round((this.adv[g] ?? 500) * sc)}]`).join(' ')}] >>`);
    const chunks: string[] = []; for (let i = 0; i < gids.length; i += 100) { const part = gids.slice(i, i + 100); chunks.push(`${part.length} beginbfchar\n${part.map((g) => `<${g.toString(16).padStart(4, '0')}> <${this.used.get(g)!.toString(16).padStart(4, '0')}>`).join('\n')}\nendbfchar`); }
    const cmapTxt = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
    w.set(tu, w.stream('', Buffer.from(cmapTxt, 'latin1')));
    w.set(t0, `<< /Type /Font /Subtype /Type0 /BaseFont /${this.name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tu} 0 R >>`);
    return t0;
  }
}

const fontDir = join(root, 'node_modules', '@fontsource', 'jost', 'files');
export interface Fonts { regular: PdfFont; bold: PdfFont; mono: PdfFont; brand: boolean }
export function loadFonts(): Fonts {
  const mono = new StandardFont('F3', 'Courier', null);
  try {
    const r = join(fontDir, 'jost-latin-400-normal.woff'), b = join(fontDir, 'jost-latin-600-normal.woff');
    if (existsSync(r) && existsSync(b)) return { regular: new TtfFont('F1', 'Jost-Regular', woffToSfnt(readFileSync(r))), bold: new TtfFont('F2', 'Jost-SemiBold', woffToSfnt(readFileSync(b))), mono, brand: true };
  } catch { /* fall back below */ }
  return { regular: new StandardFont('F1', 'Helvetica', HELV), bold: new StandardFont('F2', 'Helvetica-Bold', HELV_B), mono, brand: false };
}

// ---------------------------------------------------------------- SVG path → PDF path operators
export interface Tf { sx: number; sy: number; ox: number; oy: number } // x' = ox + sx*x ; y' = oy + sy*y (top-left coordinates of the page)
export function svgPathOps(d: string, tf: Tf, pageH: number): string | null {
  const tok = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g); if (!tok) return null;
  const P = (x: number, y: number) => `${(tf.ox + tf.sx * x).toFixed(3)} ${(pageH - (tf.oy + tf.sy * y)).toFixed(3)}`;
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, prev = ''; const out: string[] = [];
  const num = () => Number(tok[i++]);
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    if (C === 'Z') { out.push('h'); x = sx; y = sy; prev = 'Z'; continue; }
    if (C === 'M') { const a = num(), b = num(); x = rel ? x + a : a; y = rel ? y + b : b; sx = x; sy = y; out.push(`${P(x, y)} m`); cmd = rel ? 'l' : 'L'; prev = 'M'; continue; }
    if (C === 'L') { const a = num(), b = num(); x = rel ? x + a : a; y = rel ? y + b : b; out.push(`${P(x, y)} l`); prev = 'L'; continue; }
    if (C === 'H') { const a = num(); x = rel ? x + a : a; out.push(`${P(x, y)} l`); prev = 'L'; continue; }
    if (C === 'V') { const a = num(); y = rel ? y + a : a; out.push(`${P(x, y)} l`); prev = 'L'; continue; }
    if (C === 'C' || C === 'S') {
      let x1: number, y1: number;
      if (C === 'C') { const a = num(), b = num(); x1 = rel ? x + a : a; y1 = rel ? y + b : b; } else { x1 = prev === 'C' ? 2 * x - lcx : x; y1 = prev === 'C' ? 2 * y - lcy : y; }
      const c = num(), d2 = num(), e = num(), f = num();
      const x2 = rel ? x + c : c, y2 = rel ? y + d2 : d2, x3 = rel ? x + e : e, y3 = rel ? y + f : f;
      out.push(`${P(x1, y1)} ${P(x2, y2)} ${P(x3, y3)} c`); lcx = x2; lcy = y2; x = x3; y = y3; prev = 'C'; continue;
    }
    return null; // arcs / quadratic curves are not needed for the brand icon
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- page
export interface TextStyle { font?: PdfFont; size?: number; color?: RGB; anchor?: 'start' | 'middle' | 'end' }
const c3 = (c: RGB) => c.map((v) => v.toFixed(3)).join(' ');
export class Page {
  ops: string[] = []; w: number; h: number; private fonts: Fonts;
  constructor(w: number, h: number, fonts: Fonts) { this.w = w; this.h = h; this.fonts = fonts; }
  text(x: number, y: number, s: string, st: TextStyle = {}) {
    const f = st.font ?? this.fonts.regular, size = st.size ?? 10;
    if (!s) return;
    const wd = st.anchor === 'middle' ? f.width(s, size) / 2 : st.anchor === 'end' ? f.width(s, size) : 0;
    this.ops.push(`BT /${f.id} ${size} Tf ${c3(st.color ?? BRAND.ink)} rg ${(x - wd).toFixed(2)} ${(this.h - y).toFixed(2)} Td ${f.encode(s)} Tj ET`);
  }
  line(x1: number, y1: number, x2: number, y2: number, o: { w?: number; color?: RGB; dash?: number[] } = {}) {
    this.ops.push(`q ${(o.w ?? 0.6).toFixed(2)} w ${c3(o.color ?? BRAND.ink)} RG ${o.dash ? `[${o.dash.join(' ')}] 0 d ` : ''}${x1.toFixed(2)} ${(this.h - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.h - y2).toFixed(2)} l S Q`);
  }
  rect(x: number, y: number, w: number, h: number, o: { fill?: RGB; stroke?: RGB; lw?: number; radius?: number } = {}) {
    const X = x.toFixed(2), Y = (this.h - y - h).toFixed(2), W = w.toFixed(2), H = h.toFixed(2);
    const paint = o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S';
    this.ops.push(`q ${o.fill ? `${c3(o.fill)} rg ` : ''}${o.stroke ? `${c3(o.stroke)} RG ${(o.lw ?? 0.6).toFixed(2)} w ` : ''}${X} ${Y} ${W} ${H} re ${paint} Q`);
  }
  svgPath(d: string, tf: Tf, fill: RGB) { const ops = svgPathOps(d, tf, this.h); if (ops) this.ops.push(`q ${c3(fill)} rg\n${ops}\nf Q`); return !!ops; }
  roundRect(x: number, y: number, w: number, h: number, r: number, fill: RGB) {
    const k = 0.5523 * r, X = x, Y = this.h - y, P = (a: number, b: number) => `${a.toFixed(2)} ${b.toFixed(2)}`;
    this.ops.push(`q ${c3(fill)} rg ${P(X + r, Y)} m ${P(X + w - r, Y)} l ${P(X + w - r + k, Y)} ${P(X + w, Y - r + k)} ${P(X + w, Y - r)} c ${P(X + w, Y - h + r)} l ${P(X + w, Y - h + r - k)} ${P(X + w - r + k, Y - h)} ${P(X + w - r, Y - h)} c ${P(X + r, Y - h)} l ${P(X + r - k, Y - h)} ${P(X, Y - h + r - k)} ${P(X, Y - h + r)} c ${P(X, Y - r)} l ${P(X, Y - r + k)} ${P(X + r - k, Y)} ${P(X + r, Y)} c f Q`);
  }
}

// ---------------------------------------------------------------- document with flowing layout
export interface Col { title: string; w: number; align?: 'left' | 'right' | 'center'; mono?: boolean }
export class Doc {
  fonts = loadFonts(); pages: Page[] = []; page!: Page; y = 0;
  readonly W = 595.28; readonly H = 841.89; readonly mx = 48; readonly top = 78; readonly bottom = 54;
  header = ''; footer = ''; logo: { svg: string } | null = null;
  info: { title: string; header: string; footer: string };
  constructor(info: { title: string; header: string; footer: string }) { this.info = info; this.header = info.header; this.footer = info.footer; this.logo = this.readLogo(); this.newPage(); }
  get cw() { return this.W - 2 * this.mx; }
  private readLogo() { const f = join(root, 'public', 'brand', 'icon.svg'); try { return existsSync(f) ? { svg: readFileSync(f, 'utf8') } : null; } catch { return null; } }
  newPage() { this.page = new Page(this.W, this.H, this.fonts); this.pages.push(this.page); this.y = this.top; return this.page; }
  ensure(h: number) { if (this.y + h > this.H - this.bottom) this.newPage(); }
  space(h: number) { this.y += h; }
  /** The real VierApparatus icon (public/brand/icon.svg) drawn as vector paths. */
  drawLogo(p: Page, x: number, y: number, size: number) {
    if (!this.logo) return false;
    const vb = /viewBox="([^"]+)"/.exec(this.logo.svg)?.[1].split(/\s+/).map(Number); if (!vb) return false;
    const s = size / vb[2], tf: Tf = { sx: s, sy: s, ox: x - vb[0] * s, oy: y - vb[1] * s };
    const rr = /<rect[^>]*rx="([\d.]+)"[^>]*fill="(#[0-9A-Fa-f]{6})"/.exec(this.logo.svg);
    if (rr) p.roundRect(x, y, size, size, Number(rr[1]) * s, hex(rr[2]));
    for (const m of this.logo.svg.matchAll(/<path[^>]*fill="(#[0-9A-Fa-f]{6})"[^>]*d="([^"]+)"/g)) p.svgPath(m[2], tf, hex(m[1]));
    return true;
  }
  wrap(s: string, font: PdfFont, size: number, maxW: number): string[] {
    const out: string[] = [];
    for (const para of normalise(String(s ?? '')).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        let wd = word;
        while (font.width(wd, size) > maxW) { // very long tokens (hashes, accessions strings) are broken
          let k = wd.length; while (k > 1 && font.width(wd.slice(0, k), size) > maxW) k--;
          if (line) { out.push(line); line = ''; }
          out.push(wd.slice(0, k)); wd = wd.slice(k);
        }
        const t = line ? `${line} ${wd}` : wd;
        if (font.width(t, size) <= maxW) line = t; else { out.push(line); line = wd; }
      }
      out.push(line);
    }
    return out;
  }
  h1(s: string) { this.ensure(48); this.space(10); this.page.text(this.mx, this.y + 14, s, { font: this.fonts.bold, size: 15, color: BRAND.blue }); this.page.line(this.mx, this.y + 20, this.W - this.mx, this.y + 20, { w: 0.8, color: BRAND.blue }); this.y += 32; }
  h2(s: string) { this.ensure(34); this.space(4); this.page.text(this.mx, this.y + 11, s, { font: this.fonts.bold, size: 11.5 }); this.y += 19; }
  para(s: string, o: { size?: number; color?: RGB; font?: PdfFont; indent?: number; gap?: number; width?: number } = {}) {
    const size = o.size ?? 10, f = o.font ?? this.fonts.regular, lh = size * f.lineHeight, x = this.mx + (o.indent ?? 0);
    for (const l of this.wrap(s, f, size, (o.width ?? this.cw) - (o.indent ?? 0))) { this.ensure(lh); this.page.text(x, this.y + size, l, { font: f, size, color: o.color }); this.y += lh; }
    this.y += o.gap ?? 4;
  }
  bullets(items: string[], o: { size?: number; color?: RGB } = {}) {
    const size = o.size ?? 9.5, lh = size * 1.3;
    for (const it of items) {
      const ls = this.wrap(it, this.fonts.regular, size, this.cw - 14);
      this.ensure(lh * Math.min(ls.length, 2));
      this.page.rect(this.mx + 3, this.y + size * 0.5, 2.2, 2.2, { fill: BRAND.blue });
      for (const l of ls) { this.ensure(lh); this.page.text(this.mx + 12, this.y + size, l, { size, color: o.color }); this.y += lh; }
      this.y += 1.5;
    }
    this.y += 3;
  }
  kv(rows: [string, string][], o: { keyW?: number; size?: number } = {}) {
    const size = o.size ?? 9.5, kw = o.keyW ?? 120, lh = size * 1.3;
    for (const [k, v] of rows) {
      const ls = this.wrap(v || '-', this.fonts.regular, size, this.cw - kw);
      this.ensure(lh * Math.min(ls.length, 2));
      this.page.text(this.mx, this.y + size, k, { font: this.fonts.bold, size, color: BRAND.grey });
      for (const l of ls) { this.ensure(lh); this.page.text(this.mx + kw, this.y + size, l, { size }); this.y += lh; }
      this.y += 1.5;
    }
    this.y += 3;
  }
  callout(title: string, lines: string[], tone: 'info' | 'warn' = 'info') {
    const size = 9.5, lh = size * 1.32, wrapped = lines.flatMap((l) => this.wrap(l, this.fonts.regular, size, this.cw - 24).map((x, i) => (i === 0 ? { t: x, first: true } : { t: x, first: false })));
    const h = 14 + 16 + wrapped.length * lh + 4;
    this.ensure(Math.min(h, 160));
    const fill = tone === 'warn' ? hex('#FFF4E5') : BRAND.light, edge = tone === 'warn' ? BRAND.warn : BRAND.blue;
    const top = this.y, ph = this.page;
    // draw background first on the current page (long callouts continue on the next page without a box)
    const fits = this.y + h <= this.H - this.bottom;
    if (fits) { ph.rect(this.mx, top, this.cw, h, { fill }); ph.rect(this.mx, top, 3, h, { fill: edge }); }
    this.y += 10; this.page.text(this.mx + 12, this.y + 10, title, { font: this.fonts.bold, size: 10.5, color: edge }); this.y += 18;
    for (const l of wrapped) { this.ensure(lh); this.page.text(this.mx + 12, this.y + size, l.t, { size }); this.y += lh; }
    this.y += 12;
  }
  table(cols: Col[], rows: string[][], o: { size?: number; zebra?: boolean; highlight?: (r: string[], i: number) => RGB | null } = {}) {
    const size = o.size ?? 8.3, lh = size * 1.28, pad = 3.5, f = this.fonts.regular;
    const total = cols.reduce((a, c) => a + c.w, 0), scale = this.cw / total, cw = cols.map((c) => c.w * scale);
    const headLines = cols.map((c, i) => this.wrap(c.title, this.fonts.bold, size, cw[i] - 2 * pad)), headH = Math.max(...headLines.map((l) => l.length)) * lh + 2 * pad;
    const drawHead = () => {
      this.ensure(headH + 12 + 20);
      this.page.rect(this.mx, this.y, this.cw, headH, { fill: BRAND.blue });
      let x = this.mx;
      cols.forEach((c, i) => { const tx = c.align === 'right' ? x + cw[i] - pad : c.align === 'center' ? x + cw[i] / 2 : x + pad; headLines[i].forEach((l, k) => this.page.text(tx, this.y + pad + size + k * lh, l, { font: this.fonts.bold, size, color: BRAND.white, anchor: c.align === 'right' ? 'end' : c.align === 'center' ? 'middle' : 'start' })); x += cw[i]; });
      this.y += headH;
    };
    drawHead();
    rows.forEach((r, ri) => {
      const cells = r.map((t, i) => this.wrap(String(t ?? ''), cols[i].mono ? this.fonts.mono : f, size, cw[i] - 2 * pad));
      const rh = Math.max(...cells.map((c) => c.length)) * lh + 2 * pad;
      if (this.y + rh > this.H - this.bottom) { this.newPage(); drawHead(); }
      const hl = o.highlight?.(r, ri);
      if (hl) this.page.rect(this.mx, this.y, this.cw, rh, { fill: hl }); else if (o.zebra !== false && ri % 2 === 1) this.page.rect(this.mx, this.y, this.cw, rh, { fill: hex('#F4F7FB') });
      let x = this.mx;
      cells.forEach((ls, i) => { ls.forEach((l, k) => { const tx = cols[i].align === 'right' ? x + cw[i] - pad : cols[i].align === 'center' ? x + cw[i] / 2 : x + pad; this.page.text(tx, this.y + pad + size + k * lh, l, { font: cols[i].mono ? this.fonts.mono : f, size, anchor: cols[i].align === 'right' ? 'end' : cols[i].align === 'center' ? 'middle' : 'start' }); }); x += cw[i]; });
      this.page.line(this.mx, this.y + rh, this.mx + this.cw, this.y + rh, { w: 0.3, color: BRAND.line });
      this.y += rh;
    });
    this.y += 8;
  }
  /** Reserve h points of vertical space (new page if needed) and let `draw` paint into it. */
  figure(h: number, draw: (p: Page, x: number, y: number, w: number) => void) { this.ensure(h); draw(this.page, this.mx, this.y, this.cw); this.y += h + 6; }

  save(): Buffer {
    const total = this.pages.length;
    this.pages.forEach((p, i) => { // header + footer on every page (after the body so the page count is known)
      if (this.drawLogo(p, this.mx, 26, 26)) p.text(this.mx + 34, 38, 'VierStation', { font: this.fonts.bold, size: 12, color: BRAND.ink });
      else p.text(this.mx, 38, 'VierStation', { font: this.fonts.bold, size: 12 });
      p.text(this.W - this.mx, 38, this.header, { size: 8.5, color: BRAND.grey, anchor: 'end' });
      p.line(this.mx, 58, this.W - this.mx, 58, { w: 0.5, color: BRAND.line });
      p.line(this.mx, this.H - 42, this.W - this.mx, this.H - 42, { w: 0.5, color: BRAND.line });
      this.wrap(this.footer, this.fonts.regular, 7.2, this.cw - 70).slice(0, 2).forEach((l, k) => p.text(this.mx, this.H - 31 + k * 9, l, { size: 7.2, color: BRAND.grey }));
      p.text(this.W - this.mx, this.H - 28, `Page ${i + 1} of ${total}`, { size: 8, color: BRAND.grey, anchor: 'end' });
    });
    const objs: Buffer[] = [Buffer.alloc(0)]; // index = object id
    const w: ObjWriter = {
      alloc: () => { objs.push(Buffer.alloc(0)); return objs.length - 1; },
      set: (id, body) => { objs[id] = Buffer.concat([Buffer.from(`${id} 0 obj\n`, 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]); },
      stream: (dict, data, compress = true) => { const d = compress ? deflateSync(data) : data; return Buffer.concat([Buffer.from(`<< ${dict} ${compress ? '/Filter /FlateDecode ' : ''}/Length ${d.length} >>\nstream\n`, 'latin1'), d, Buffer.from('\nendstream', 'latin1')]); },
    };
    const catalog = w.alloc(), pagesId = w.alloc(), info = w.alloc();
    const fontIds = [this.fonts.regular, this.fonts.bold, this.fonts.mono].map((f) => ({ f, id: 0 }));
    // fonts must be emitted AFTER all text was encoded (so the used-glyph tables are complete): build page streams first
    const streams = this.pages.map((p) => Buffer.from(p.ops.join('\n'), 'latin1'));
    fontIds.forEach((x) => { x.id = x.f.emit(w); });
    const res = `<< /Font << ${fontIds.map((x) => `/${x.f.id} ${x.id} 0 R`).join(' ')} >> >>`;
    const pageIds = this.pages.map((p, i) => { const cs = w.alloc(), pg = w.alloc(); w.set(cs, w.stream('', streams[i])); w.set(pg, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources ${res} /Contents ${cs} 0 R >>`); return pg; });
    w.set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((x) => `${x} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    w.set(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    const esc = (s: string) => normalise(s).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
    const d = new Date(); const pd = `D:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`;
    w.set(info, `<< /Title (${esc(this.info.title)}) /Producer (VierStation Sequence Lab) /Creator (VierStation) /CreationDate (${pd}) >>`);
    const parts: Buffer[] = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; const offs: number[] = [0]; let pos = parts[0].length;
    for (let i = 1; i < objs.length; i++) { offs[i] = pos; parts.push(objs[i]); pos += objs[i].length; }
    const xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n${offs.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
    parts.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(parts);
  }
}
