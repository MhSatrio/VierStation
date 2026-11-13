// Helpers for building the VierStation documentation with docx-js.
const fs = require('fs');
const D = require('docx');
const { Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, HeadingLevel, WidthType, ShadingType, BorderStyle, AlignmentType, LevelFormat } = D;

const BLUE = '4570B6', INK = '231F20', LIGHT = 'CAEBFB', GREY = '6B6B6B', NAVY = '14295A', FONT = 'Arial';
const W = 9026; // A4 content width in DXA with 1-inch margins

/** inline markup: **bold**, `code`, _italic_ */
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), font: FONT, ...base }));
    const t = m[0];
    if (t.startsWith('**')) out.push(new TextRun({ text: t.slice(2, -2), bold: true, font: FONT, ...base }));
    else if (t.startsWith('`')) out.push(new TextRun({ text: t.slice(1, -1), font: 'Consolas', size: (base.size ?? 21) - 2, color: NAVY, shading: { type: ShadingType.CLEAR, fill: 'EEF3FA' }, ...{ ...base, bold: base.bold } }));
    else out.push(new TextRun({ text: t.slice(1, -1), italics: true, font: FONT, ...base }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), font: FONT, ...base }));
  return out;
}
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t, font: FONT })], pageBreakBefore: true });
const H1n = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t, font: FONT })] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t, font: FONT })] });
const H3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: t, font: FONT })] });
const P = (t, o = {}) => new Paragraph({ spacing: { after: 120, line: 276 }, alignment: o.align, keepNext: o.keepNext, children: runs(t, { size: o.size ?? 21, color: o.color ?? INK, italics: o.italics }) });
const small = (t) => P(t, { size: 18, color: GREY });

let inst = 0;
const bullets = (items, o = {}) => items.map((t) => new Paragraph({ numbering: { reference: 'bul', level: o.level ?? 0 }, spacing: { after: 60, line: 264 }, children: runs(t, { size: 21 }) }));
/** numbered steps – each call restarts at 1 */
const steps = (items) => { const instance = ++inst; return items.map((t) => new Paragraph({ numbering: { reference: 'num', level: 0, instance }, spacing: { after: 80, line: 264 }, children: runs(t, { size: 21 }) })); };

const code = (text) => text.split('\n').map((l, i, a) => new Paragraph({ spacing: { after: 0, line: 240 }, shading: { type: ShadingType.CLEAR, fill: 'F3F6FA' }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: BLUE, space: 6 } }, indent: { left: 140 }, keepNext: i < a.length - 1, children: [new TextRun({ text: l || ' ', font: 'Consolas', size: 18, color: INK })] })).concat([new Paragraph({ spacing: { after: 100 }, children: [] })]);

/** callout: kind info | warn | ok */
function callout(title, text, kind = 'info') {
  const fill = kind === 'warn' ? 'FFF4E5' : kind === 'ok' ? 'E8F6EE' : 'EAF4FB', edge = kind === 'warn' ? 'B45309' : kind === 'ok' ? '1E7B4A' : BLUE;
  const lines = Array.isArray(text) ? text : [text];
  return [
    new Paragraph({ keepNext: true, spacing: { before: 80, after: 0 }, shading: { type: ShadingType.CLEAR, fill }, border: { left: { style: BorderStyle.SINGLE, size: 24, color: edge, space: 8 } }, indent: { left: 160 }, children: [new TextRun({ text: title, bold: true, font: FONT, size: 21, color: edge })] }),
    ...lines.map((l, i) => new Paragraph({ keepNext: i < lines.length - 1, spacing: { after: i === lines.length - 1 ? 140 : 0, line: 264 }, shading: { type: ShadingType.CLEAR, fill }, border: { left: { style: BorderStyle.SINGLE, size: 24, color: edge, space: 8 } }, indent: { left: 160 }, children: runs(l, { size: 20 }) })),
  ];
}

function pngSize(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }
function image(file, maxW = 600, caption) {
  const data = fs.readFileSync(file); const { w, h } = pngSize(data); const k = Math.min(1, maxW / w);
  const out = [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 80, after: caption ? 40 : 140 }, keepNext: !!caption, children: [new ImageRun({ type: 'png', data, transformation: { width: Math.round(w * k), height: Math.round(h * k) }, altText: { title: caption ?? 'figure', description: caption ?? 'figure', name: 'figure' } })] })];
  if (caption) out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: caption, italics: true, size: 18, color: GREY, font: FONT })] }));
  return out;
}

const thin = { style: BorderStyle.SINGLE, size: 4, color: 'C9D3E0' };
const borders = { top: thin, bottom: thin, left: thin, right: thin };
/** table: widths are relative and scaled to the page width */
function table(head, rows, widths, o = {}) {
  const sum = widths.reduce((a, b) => a + b, 0); let acc = 0;
  const cw = widths.map((w, i) => { const v = i === widths.length - 1 ? W - acc : Math.round((w / sum) * W); acc += v; return v; });
  const size = o.size ?? 18;
  const cell = (t, i, header, ri) => new TableCell({
    width: { size: cw[i], type: WidthType.DXA }, borders, margins: { top: 50, bottom: 50, left: 90, right: 90 },
    shading: header ? { type: ShadingType.CLEAR, fill: BLUE } : ri % 2 ? { type: ShadingType.CLEAR, fill: 'F4F7FB' } : undefined,
    children: String(t).split('\n').map((line) => new Paragraph({ spacing: { after: 0, line: 252 }, children: header ? [new TextRun({ text: line, bold: true, color: 'FFFFFF', size, font: FONT })] : (o.mono && o.mono.includes(i) ? [new TextRun({ text: line, font: 'Consolas', size: size - 1, color: INK })] : runs(line, { size })) })),
  });
  return [new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: cw, rows: [new TableRow({ tableHeader: true, cantSplit: true, children: head.map((h, i) => cell(h, i, true, 0)) }), ...rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((t, i) => cell(t, i, false, ri)) }))] }), new Paragraph({ spacing: { after: 140 }, children: [] })];
}

const spacer = () => new Paragraph({ spacing: { after: 120 }, children: [] });
module.exports = { D, BLUE, INK, LIGHT, GREY, NAVY, FONT, W, runs, H1, H1n, H2, H3, P, small, bullets, steps, code, callout, image, table, spacer };
