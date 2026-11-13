// Sequence file formats: FASTA (shared), FASTQ, and ABIF (.ab1 Sanger chromatograms). Pure functions, no I/O.
import { cleanSeq, detectSeqKind, parseFasta } from '../../shared/sequence.ts';

export interface ParsedRead { id: string; description: string; seq: string; qual: number[] | null; source: 'fasta' | 'fastq' | 'ab1' | 'text'; warnings: string[] }

/** FASTQ (4-line records). Phred+33 (Sanger / Illumina 1.8+) is assumed; Phred+64 files are detected and converted with a warning. */
export function parseFastq(text: string): ParsedRead[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: ParsedRead[] = [];
  for (let i = 0; i + 3 < lines.length + 0 && i < lines.length; i += 4) {
    if (!lines[i]) { if (lines.slice(i).every((l) => !l.trim())) break; continue; }
    const h = lines[i], seq = lines[i + 1] ?? '', plus = lines[i + 2] ?? '', q = lines[i + 3] ?? '';
    if (!h.startsWith('@') || !plus.startsWith('+')) throw new Error(`Line ${i + 1}: not a valid FASTQ record (expected "@id" … "+" …)`);
    if (seq.length !== q.length) throw new Error(`Read "${h.slice(1).split(/\s/)[0]}": sequence length ${seq.length} differs from quality length ${q.length}`);
    const codes = [...q].map((c) => c.charCodeAt(0));
    const warnings: string[] = [];
    let offset = 33;
    if (codes.length && Math.min(...codes) >= 59 && Math.max(...codes) > 74) { offset = 64; warnings.push('Quality characters look like Phred+64 (Illumina 1.3–1.7); converted to Phred scores.'); }
    const sp = h.slice(1).search(/\s/);
    out.push({ id: sp < 0 ? h.slice(1) : h.slice(1, sp + 1), description: sp < 0 ? '' : h.slice(sp + 2).trim(), seq: cleanSeq(seq), qual: codes.map((c) => Math.max(0, c - offset)), source: 'fastq', warnings });
  }
  if (!out.length) throw new Error('No FASTQ records found');
  return out;
}

// ---------------- ABIF ----------------
export interface Chromatogram {
  seq: string; qual: number[]; ploc: number[]; traces: Record<'A' | 'C' | 'G' | 'T', number[]>; order: string; points: number;
  meta: { sample?: string; machine?: string; model?: string; dye?: string; runDate?: string; version: number; basecaller?: string };
  /** secondary-peak ratio per base (second highest channel at the called peak / highest) – drives ambiguity suggestions */
  secondary: { ratio: number; base: string }[];
}

interface Entry { name: string; num: number; type: number; size: number; n: number; dataSize: number; off: number; raw4: Buffer }

/** Parse an Applied Biosystems ABIF file (.ab1). Throws a readable error when the file is not a valid ABIF. */
export function parseAb1(buf: Buffer): Chromatogram {
  if (buf.length < 34 || buf.toString('latin1', 0, 4) !== 'ABIF') throw new Error('Not an ABIF/AB1 file (missing "ABIF" header)');
  const version = buf.readUInt16BE(4);
  const rd = (o: number): Entry => ({ name: buf.toString('latin1', o, o + 4), num: buf.readInt32BE(o + 4), type: buf.readInt16BE(o + 8), size: buf.readInt16BE(o + 10), n: buf.readInt32BE(o + 12), dataSize: buf.readInt32BE(o + 16), off: buf.readInt32BE(o + 20), raw4: buf.subarray(o + 20, o + 24) });
  const dir = rd(6);
  if (dir.name !== 'tdir' || dir.off + dir.n * 28 > buf.length) throw new Error('ABIF directory is missing or truncated');
  const entries: Entry[] = [];
  for (let i = 0; i < dir.n; i++) entries.push(rd(dir.off + i * 28));
  const find = (name: string, num: number) => entries.find((e) => e.name === name && e.num === num);
  const data = (e: Entry): Buffer => (e.dataSize <= 4 ? e.raw4.subarray(0, e.dataSize) : buf.subarray(e.off, e.off + e.dataSize));
  const text = (e?: Entry) => { if (!e) return undefined; const d = data(e); return e.type === 18 ? d.toString('latin1', 1, 1 + d[0]) : d.toString('latin1').replace(/\0+$/, ''); };
  const i16 = (e: Entry) => { const d = data(e); return Array.from({ length: Math.floor(d.length / 2) }, (_, i) => d.readInt16BE(i * 2)); };

  const bases = find('PBAS', 2) ?? find('PBAS', 1);
  if (!bases) throw new Error('This ABIF file has no base calls (PBAS)');
  const seq = cleanSeq(data(bases).toString('latin1'));
  const q = find('PCON', find('PBAS', 2) ? 2 : 1) ?? find('PCON', 1);
  const qual = q ? [...data(q)] : [];
  const pl = find('PLOC', find('PBAS', 2) ? 2 : 1) ?? find('PLOC', 1);
  const ploc = pl ? i16(pl).map((v) => (v < 0 ? v + 65536 : v)) : [];
  const order = (text(find('FWO_', 1)) ?? 'GATC').toUpperCase();
  const traces = { A: [] as number[], C: [] as number[], G: [] as number[], T: [] as number[] };
  order.split('').forEach((b, k) => { const e = find('DATA', 9 + k); if (e && b in traces) traces[b as 'A'] = i16(e); });
  if (!traces.A.length) throw new Error('This ABIF file has no processed trace data (DATA 9–12)');
  const points = traces.A.length;
  if (qual.length && qual.length !== seq.length) throw new Error(`Quality values (${qual.length}) do not match base calls (${seq.length})`);
  if (ploc.length && ploc.length < seq.length) throw new Error('Peak locations are fewer than base calls');
  const secondary = seq.split('').map((_, i) => {
    const p = ploc[i];
    if (p === undefined || p >= points) return { ratio: 0, base: '' };
    const h = (['A', 'C', 'G', 'T'] as const).map((b) => ({ b, v: Math.max(0, traces[b][p] ?? 0) })).sort((a, b) => b.v - a.v);
    return { ratio: h[0].v > 0 ? Math.round((h[1].v / h[0].v) * 1000) / 1000 : 0, base: h[1].b };
  });
  return {
    seq, qual, ploc, traces, order, points, secondary,
    meta: { sample: text(find('SMPL', 1)), machine: text(find('MCHN', 1)), model: text(find('MODL', 1)), dye: text(find('DySN', 1)), basecaller: text(find('SPAC', 1)) ? undefined : undefined, version },
  };
}

/** Build a minimal but valid ABIF file (for tests and for documentation of the supported subset). */
export function buildAb1(o: { seq: string; qual: number[]; traces: Record<'A' | 'C' | 'G' | 'T', number[]>; ploc: number[]; sample?: string; order?: string }): Buffer {
  const order = o.order ?? 'GATC';
  const items: { name: string; num: number; type: number; size: number; n: number; data: Buffer }[] = [];
  const i16 = (a: number[]) => { const b = Buffer.alloc(a.length * 2); a.forEach((v, i) => b.writeInt16BE(v, i * 2)); return b; };
  items.push({ name: 'PBAS', num: 2, type: 2, size: 1, n: o.seq.length, data: Buffer.from(o.seq, 'latin1') });
  items.push({ name: 'PCON', num: 2, type: 1, size: 1, n: o.qual.length, data: Buffer.from(o.qual) });
  items.push({ name: 'PLOC', num: 2, type: 4, size: 2, n: o.ploc.length, data: i16(o.ploc) });
  items.push({ name: 'FWO_', num: 1, type: 2, size: 1, n: 4, data: Buffer.from(order, 'latin1') });
  order.split('').forEach((b, k) => items.push({ name: 'DATA', num: 9 + k, type: 4, size: 2, n: o.traces[b as 'A'].length, data: i16(o.traces[b as 'A']) }));
  if (o.sample) items.push({ name: 'SMPL', num: 1, type: 18, size: 1, n: o.sample.length + 1, data: Buffer.concat([Buffer.from([o.sample.length]), Buffer.from(o.sample, 'latin1')]) });
  const dirOff = 128; // data blocks first, directory last
  let cur = dirOff + items.length * 28;
  const dirBuf = Buffer.alloc(items.length * 28);
  const blocks: Buffer[] = [];
  items.forEach((it, i) => {
    const o2 = i * 28;
    dirBuf.write(it.name, o2, 'latin1'); dirBuf.writeInt32BE(it.num, o2 + 4); dirBuf.writeInt16BE(it.type, o2 + 8); dirBuf.writeInt16BE(it.size, o2 + 10); dirBuf.writeInt32BE(it.n, o2 + 12); dirBuf.writeInt32BE(it.data.length, o2 + 16);
    if (it.data.length <= 4) it.data.copy(dirBuf, o2 + 20); else { dirBuf.writeInt32BE(cur, o2 + 20); blocks.push(it.data); cur += it.data.length; }
  });
  const head = Buffer.alloc(dirOff);
  head.write('ABIF', 0, 'latin1'); head.writeUInt16BE(101, 4);
  head.write('tdir', 6, 'latin1'); head.writeInt32BE(1, 10); head.writeInt16BE(1023, 14); head.writeInt16BE(28, 16); head.writeInt32BE(items.length, 18); head.writeInt32BE(items.length * 28, 22); head.writeInt32BE(dirOff, 26);
  return Buffer.concat([head, dirBuf, ...blocks]);
}

// ---------------- generic entry point ----------------
export type InputKind = 'fasta' | 'fastq' | 'ab1' | 'text';
export function sniff(name: string, head: Buffer | string): InputKind {
  const n = name.toLowerCase();
  const b = typeof head === 'string' ? Buffer.from(head, 'latin1') : head;
  if (b.subarray(0, 4).toString('latin1') === 'ABIF') return 'ab1';
  const t = b.subarray(0, 8).toString('latin1');
  if (t.startsWith('@') && !n.endsWith('.fasta')) return 'fastq';
  if (t.startsWith('>') || /\.(fa|fas|fasta|fna|seq)$/.test(n)) return 'fasta';
  return 'text';
}

export function parseSequenceText(text: string, fileName = 'pasted sequence'): ParsedRead[] {
  const kind = sniff(fileName, text);
  if (kind === 'fastq') return parseFastq(text);
  const recs = parseFasta(text);
  if (!recs.length) throw new Error('No sequence found. Paste FASTA text or a plain nucleotide sequence.');
  return recs.map((r) => {
    const k = detectSeqKind(r.seq);
    if (k === 'protein') throw new Error(`"${r.id}" looks like a protein sequence; the DNA Sequence Lab needs nucleotides.`);
    if (k === 'unknown') throw new Error(`"${r.id}" contains characters that are not nucleotide codes.`);
    const w: string[] = [];
    if (/U/.test(r.seq) && !/T/.test(r.seq)) w.push('Sequence contains U (RNA); converted to T.');
    return { id: r.id === 'sequence' && fileName !== 'pasted sequence' ? fileName.replace(/\.[^.]+$/, '') : r.id, description: r.description, seq: r.seq.replace(/U/g, 'T').replace(/[^A-Z]/g, ''), qual: null, source: (kind === 'fasta' ? 'fasta' : 'text') as 'fasta' | 'text', warnings: w };
  });
}
