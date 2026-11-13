// The Sequence Lab PDF report. Every statement and number comes from the STORED workflow (seq_ops / seq_versions); sections for steps that were not run say so.
import { createHash } from 'node:crypto';
import { BRAND, Doc, hex, normalise } from '../report/pdf.ts';
import type { Page, PdfFont, RGB } from '../report/pdf.ts';
import { layoutTree, figureToSvg } from '../report/treeDraw.ts';
import type { LeafLook, TreeFigure } from '../report/treeDraw.ts';
import { getRaw } from '../records.ts';
import { fieldByKey } from '../schema.ts';
import { latestOp, listOps, listVersions, stateOf } from './store.ts';
import type { Op } from './store.ts';
import { currentDataset, recordName } from './dataset.ts';
import type { Member } from './dataset.ts';
import { buildScript, versionChain } from './exports.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const fmtT = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
const num = (x: unknown, d = 1) => (typeof x === 'number' && Number.isFinite(x) ? String(+x.toFixed(d)) : '-');
const sci = (x: unknown) => (typeof x === 'number' ? (x === 0 ? '0' : x < 0.001 ? x.toExponential(1) : String(+x.toFixed(4))) : '-');

const BASE_COL: Record<string, string> = { A: '#7FB069', C: '#4570B6', G: '#E3B23C', T: '#D1495B' };
const colorOf = (c: string): RGB | null => (c === '-' ? null : hex(BASE_COL[c] ?? '#B8BEC6'));

/** Colour strip(s) of sequences: one row per sequence, consecutive identical symbols are drawn as one rectangle. */
function strips(p: Page, d: Doc, x: number, y: number, w: number, rows: { label: string; seq: string; tone?: 'query' | 'outgroup' | 'ingroup' }[], o: { labelW: number; rowH: number; conservation?: boolean }): number {
  const L = Math.max(...rows.map((r) => r.seq.length)), pw = w - o.labelW, sx = pw / L;
  let yy = y;
  if (o.conservation) {
    for (let i = 0; i < L;) {
      const col = (j: number) => { const cs = rows.map((r) => r.seq[j]).filter((c) => c && 'ACGT'.includes(c)); return cs.length > 1 && cs.every((c) => c === cs[0]); };
      const v = col(i); let k = i + 1; while (k < L && col(k) === v) k++;
      p.rect(x + o.labelW + i * sx, yy, (k - i) * sx + 0.15, 5, { fill: v ? hex('#231F20') : hex('#E1E6EE') }); i = k;
    }
    p.text(x, yy + 5, 'identical in all', { size: 6.5, color: BRAND.grey }); yy += 8;
  }
  for (const r of rows) {
    p.text(x, yy + o.rowH - 1.6, r.label.length > 38 ? r.label.slice(0, 37) + '…' : r.label, { size: Math.min(7.5, o.rowH), font: r.tone === 'query' ? d.fonts.bold : d.fonts.regular, color: r.tone === 'query' ? BRAND.blue : r.tone === 'outgroup' ? BRAND.grey : BRAND.ink });
    for (let i = 0; i < r.seq.length;) {
      const ch = r.seq[i]; let k = i + 1; while (k < r.seq.length && r.seq[k] === ch) k++;
      const fill = colorOf(ch); if (fill) p.rect(x + o.labelW + i * sx, yy, (k - i) * sx + 0.15, o.rowH - 1.5, { fill }); else p.rect(x + o.labelW + i * sx, yy + (o.rowH - 1.5) / 2 - 0.2, (k - i) * sx, 0.5, { fill: hex('#9AA0A6') });
      i = k;
    }
    yy += o.rowH;
  }
  return yy - y;
}

function legend(p: Page, d: Doc, x: number, y: number) {
  let xx = x;
  for (const [c, name] of [['A', 'A'], ['C', 'C'], ['G', 'G'], ['T', 'T'], ['N', 'N / ambiguity code'], ['-', 'gap']] as const) {
    const fill = colorOf(c); if (fill) p.rect(xx, y, 8, 8, { fill }); else p.rect(xx, y + 3.7, 8, 0.6, { fill: hex('#9AA0A6') });
    p.text(xx + 11, y + 7, name, { size: 7.5, color: BRAND.grey }); xx += 14 + d.fonts.regular.width(name, 7.5) + 8;
  }
}

function seqStats(seq: string) {
  const c = { A: 0, C: 0, G: 0, T: 0, N: 0, other: 0 } as Record<string, number>;
  for (const ch of seq) { if (ch in c && ch !== 'other') c[ch]++; else c.other++; }
  let longest = 0, cur = 0; for (const ch of seq) { if ('ACGT'.includes(ch)) { cur++; if (cur > longest) longest = cur; } else cur = 0; }
  const acgt = c.A + c.C + c.G + c.T;
  return { ...c, length: seq.length, ambiguous: c.N + c.other, ambiguousPct: seq.length ? ((c.N + c.other) / seq.length) * 100 : 0, gc: acgt ? ((c.G + c.C) / acgt) * 100 : 0, longestRun: longest };
}
function identityNoN(h: any): number | null {
  const q: string | undefined = h.hsps?.[0]?.qseq, s: string | undefined = h.hsps?.[0]?.hseq; if (!q || !s) return null;
  let cmp = 0, same = 0;
  for (let i = 0; i < Math.min(q.length, s.length); i++) { const a = q[i].toUpperCase(), b = s[i].toUpperCase(); if ('ACGT'.includes(a) && 'ACGT'.includes(b)) { cmp++; if (a === b) same++; } }
  return cmp ? (same / cmp) * 100 : null;
}

const paramText = (p: Record<string, any>) => Object.entries(p ?? {}).filter(([k, v]) => v !== undefined && v !== null && !['reverseSeq', 'reverseQual', 'names'].includes(k) && typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(', ');

export interface ReportOpts { generatedFor?: string; organisationNote?: string }
export interface Report { pdf: Buffer; treeSvg: string | null; pages: number }

function treeLook(members: Member[]) {
  const byLabel = new Map(members.map((m) => [m.label, m]));
  return (name: string): LeafLook => {
    const m = byLabel.get(name);
    if (!m) return { text: name, role: 'other' };
    if (m.role === 'query') return { text: 'Your sequence (query)', role: 'query' };
    return { text: `${m.organism}${m.accession ? ` (${m.accession})` : ''}${m.role === 'outgroup' ? ' - outgroup' : ''}`, role: m.role };
  };
}
export function buildTreeFigure(res: any, members: Member[], fonts: { regular: PdfFont; bold: PdfFont }, width: number): TreeFigure {
  const leaves = res.labels?.length ?? 10, rowH = Math.max(8, Math.min(16, 620 / leaves)), fs = Math.min(9, rowH * 0.62 + 2);
  return layoutTree(res.tree, treeLook(members), { width, rowH, fontSize: fs, measure: (s, size, bold) => (bold ? fonts.bold : fonts.regular).width(s, size), supportMin: 0 });
}

export function buildReport(recordId: string, o: ReportOpts = {}): Report {
  const st = stateOf(recordId); if (!st) throw new Error('This record has no Sequence Lab history.');
  const name = recordName(recordId), rec = getRaw(recordId), ops = listOps(recordId, { withResult: true }), versions = listVersions(recordId), chain = versionChain(recordId);
  const meta = st.meta as Record<string, any>;
  const fieldVal = (key: string) => { if (!rec) return ''; const f = fieldByKey(rec.tableId, key); return f ? String(rec.data[f.id] ?? '') : ''; };
  const now = new Date().toISOString();
  const d = new Doc({ title: `Sequence identification report - ${name}`, header: `Sequence Lab report - ${name.length > 40 ? name.slice(0, 39) + '...' : name}`, footer: `Generated by VierStation from the stored workflow history of record ${recordId} on ${fmtT(now)}. A report states what the data show; it does not replace expert judgement.` });
  const F = d.fonts;
  const blast = latestOp(recordId, 'blast'), treeOp = latestOp(recordId, 'tree'), ident = latestOp(recordId, 'identify'), outgOp = latestOp(recordId, 'outgroups'), relOp = latestOp(recordId, 'relatives'), speciesOp = latestOp(recordId, 'species');
  const alOp = (() => { const a = latestOp(recordId, 'align'), e = latestOp(recordId, 'align_edit'); return e && a && e.createdAt >= a.createdAt ? e : a; })();
  const ds = currentDataset(recordId), members: Member[] = ds?.dataset.members ?? [];
  const head = stats(st.head.seq), raw = stats(st.raw.seq);
  function stats(s: string) { return seqStats(s); }
  const tr = treeOp?.result, interp = tr?.interpretation;
  const mergeOp = ops.find((x) => (x.step === 'clean' && x.params?.op === 'merge_reverse' && chain.some((v) => v.opId === x.id)) || (x.step === 'import' && x.params?.source === 'merge'));

  // ------------------------------------------------------------ title block
  d.page.text(d.mx, d.y + 20, 'Sequence identification report', { font: F.bold, size: 23, color: BRAND.ink }); d.y += 34;
  d.page.text(d.mx, d.y + 12, name, { font: F.regular, size: 14, color: BRAND.blue }); d.y += 26;
  d.kv([
    ['Sample / marker', [fieldVal('sampleId') || name, fieldVal('marker')].filter(Boolean).join(' - ')],
    ['Source', `${meta.source ?? 'unknown'}${meta.fileName ? ` (${meta.fileName})` : ''}${o.generatedFor ? ` - prepared for ${o.generatedFor}` : ''}`],
    ['Generated', fmtT(now)],
    ['Record', recordId],
  ], { keyW: 105 });

  // ------------------------------------------------------------ summary
  d.h1('Summary');
  const topHit = blast?.result?.hits?.[0];
  const sumLines: string[] = [];
  sumLines.push(`Working sequence: ${head.length} bp (${head.ambiguousPct.toFixed(1)}% N or ambiguity codes; longest stretch without any: ${head.longestRun} bp).`);
  if (mergeOp) sumLines.push(`Forward and reverse reads were merged: ${mergeOp.changes && (mergeOp.changes as any).summary ? (mergeOp.changes as any).summary : 'see section 2'}.`);
  sumLines.push(topHit ? `Best NCBI BLAST match: ${topHit.organism} (${topHit.accession}) - ${topHit.identityPct}% identity over ${topHit.coveragePct}% of your sequence, E = ${sci(topHit.evalue)}.` : blast ? 'NCBI BLAST was run but found no significant similarity.' : 'NCBI BLAST has not been run.');
  sumLines.push(interp ? `Tree reading: ${interp.statement}` : treeOp ? 'A tree exists but has no stored interpretation.' : 'No phylogenetic tree has been built yet.');
  sumLines.push(ident?.result ? `Conclusion recorded by ${ident.actorName ?? 'a user'}: ${ident.result.taxon} (${ident.result.rank}), confidence: ${ident.result.confidence}.` : 'No identification has been recorded by a person. This report describes the evidence; it does not make the identification.');
  d.callout('What the data show', sumLines);
  const cautions: string[] = [];
  if (head.ambiguousPct >= 10) cautions.push(`${head.ambiguousPct.toFixed(1)}% of the sequence is unreadable (N / ambiguity codes). BLAST counts every N as a mismatch, so identities are understated, and seeds of exact matches are short (longest clean stretch: ${head.longestRun} bp). Sequencing the other strand or repeating the read is the most effective way to strengthen the result.`);
  if (topHit && topHit.coveragePct < 50) cautions.push(`Only ${topHit.coveragePct}% of your sequence aligns to the best match; identity values describe that short aligned part only.`);
  for (const w of (interp?.limitations ?? []).slice(0, 2)) cautions.push(w);
  if (cautions.length) d.callout('Read this before relying on the result', cautions, 'warn');

  // ------------------------------------------------------------ 1 sequence & quality
  d.h1('1  Raw sequence and quality');
  d.table([{ title: '', w: 120 }, { title: 'Length (bp)', w: 70, align: 'right' }, { title: 'A', w: 40, align: 'right' }, { title: 'C', w: 40, align: 'right' }, { title: 'G', w: 40, align: 'right' }, { title: 'T', w: 40, align: 'right' }, { title: 'N / other', w: 60, align: 'right' }, { title: 'GC %', w: 50, align: 'right' }, { title: 'SHA-256 (first 12)', w: 110, mono: true }],
    [['Raw (immutable)', raw, st.raw.seq], [`Working version v${st.head.n}`, head, st.head.seq]].map(([label, s, seq]) => [String(label), String((s as any).length), String((s as any).A), String((s as any).C), String((s as any).G), String((s as any).T), String((s as any).ambiguous), (s as any).gc.toFixed(1), sha(String(seq)).slice(0, 12)]));
  d.para(st.raw.qual ? `The input carries Phred quality scores (mean Q${(st.raw.qual.reduce((a, b) => a + b, 0) / st.raw.qual.length).toFixed(1)}).` : 'The input has no quality scores (FASTA / pasted text), so quality trimming and chromatogram checks are not available for this sequence. Unreadable positions are the N characters in the sequence itself.', { size: 9.5, color: BRAND.grey });
  d.figure(40, (p, x, y, w) => { p.text(x, y + 7, 'Base-call map of the working sequence (grey = N / ambiguity code)', { size: 8, color: BRAND.grey }); strips(p, d, x, y + 12, w, [{ label: '', seq: st.head.seq }], { labelW: 0, rowH: 12 }); legend(p, d, x, y + 28); });

  // ------------------------------------------------------------ 2 cleaning / merge
  d.h1('2  Cleaning and read merging');
  const cleanOps = ops.filter((x) => x.step === 'clean');
  if (!cleanOps.length) d.para('No cleaning operation was applied: the working sequence is identical to the raw sequence.');
  else {
    d.para('Cleaning never changes the raw sequence. Each operation creates a new version; undone operations stay in the history but are not part of the current sequence.', { size: 9.5, color: BRAND.grey });
    d.table([{ title: '#', w: 22 }, { title: 'Operation', w: 150 }, { title: 'What changed', w: 270 }, { title: 'Current?', w: 55, align: 'center' }],
      cleanOps.map((x, i) => [String(i + 1), x.name, `${(x.changes as any)?.summary ?? ''}${paramText(x.params) ? ` [${paramText(x.params)}]` : ''}`, chain.some((v) => v.opId === x.id) ? 'yes' : 'undone']));
  }
  if (mergeOp) {
    const c = mergeOp.changes as any;
    d.h2('Forward + reverse merge');
    d.kv([
      ['Method', 'Overlap alignment of the two reads (match +2, mismatch -3, gap -4; N and ambiguity codes score 0), then a column-by-column consensus.'],
      ...(mergeOp.step === 'import' ? [['Inputs', `forward: "${mergeOp.params.forwardName}" (record ${mergeOp.params.forwardRecordId}, version ${mergeOp.params.forwardVersionN}); reverse: "${mergeOp.params.reverseName}" (record ${mergeOp.params.reverseRecordId}, version ${mergeOp.params.reverseVersionN}). This sequence is the merged record; both source records are unchanged.`] as [string, string]] : []),
      ['Reverse read', `${c.reverseReadLength} bp${mergeOp.params?.reverseRecordId ? ` (stored as its own record ${mergeOp.params.reverseRecordId})` : ''}; orientation: ${c.orientation}`],
      ['Overlap', `${c.overlapColumns} columns, ${c.overlapIdentityPct}% identical over ${c.overlapComparedBases} comparable bases`],
      ['Consensus rules', 'Agreement keeps the base. An N or ambiguity code opposite a real base takes the real base. Two different real bases take the one with clearly higher Phred score if both reads have scores, otherwise an IUPAC code is written.'],
      ['Outcome', `${c.ambiguousResolvedByOtherRead} N/ambiguous positions resolved by the other read; ${c.resolvedByQuality} by quality; ${c.writtenAsIupac} written as IUPAC codes; ${c.indelColumns} positions present in only one read inside the overlap. Ambiguous bases ${c.ambiguousBefore} -> ${c.ambiguousAfter}; length ${c.before} -> ${c.after} bp.`],
    ], { keyW: 100 });
    for (const w of mergeOp.warnings) d.para(`Note: ${w}`, { size: 9, color: BRAND.warn });
  }

  // ------------------------------------------------------------ 3 BLAST
  d.h1('3  NCBI similarity search (BLAST)');
  if (!blast?.result?.hits) d.para('BLAST has not been run for this record.');
  else {
    const r = blast.result, p = blast.params;
    d.kv([['Search', `${p.program} against ${p.db}, up to ${p.hitlist} hits, E-value threshold ${p.expect}${p.entrez ? `, restricted by ${p.entrez}` : ''}`], ['Query', `${r.queryLength} bp (working version used at that time)`], ['NCBI request id', `${r.rid} - retrieved ${fmtT(r.retrievedAt ?? blast.createdAt)}`], ['Result', r.summary]], { keyW: 100 });
    d.table([{ title: '#', w: 18 }, { title: 'Organism', w: 150 }, { title: 'Accession', w: 66 }, { title: 'Identity %', w: 48, align: 'right' }, { title: 'Identity % (N ignored)', w: 62, align: 'right' }, { title: 'Query coverage %', w: 54, align: 'right' }, { title: 'E-value', w: 50, align: 'right' }, { title: 'Bit score', w: 44, align: 'right' }],
      r.hits.slice(0, 12).map((h: any, i: number) => [String(i + 1), h.organism, h.accession, num(h.identityPct, 2), num(identityNoN(h), 1), num(h.coveragePct, 1), sci(h.evalue), num(h.bitScore, 0)]));
    d.para(`Identity and coverage are separate measures: identity is the share of matching positions inside the aligned part; coverage is how much of YOUR sequence that alignment spans. "N ignored" repeats the identity without counting positions where your read has an N or ambiguity code. The table is sorted by bit score; ${r.hits.length} hit(s) are stored with the operation.`, { size: 9, color: BRAND.grey });
  }

  // ------------------------------------------------------------ 4 dataset
  d.h1('4  Reference sequences (relatives and outgroups)');
  if (!ds || members.length < 2) d.para('No reference dataset has been assembled yet.');
  else {
    d.para(`${members.filter((m) => m.role === 'ingroup').length} ingroup and ${members.filter((m) => m.role === 'outgroup').length} outgroup reference sequence(s) were used. Each row shows why the sequence is in the dataset; the region is the part of the record that BLAST aligned to your sequence, returned in your sequence's orientation.`, { size: 9.5, color: BRAND.grey });
    d.table([{ title: 'Role', w: 44 }, { title: 'Organism', w: 118 }, { title: 'Accession', w: 62 }, { title: 'Identity / coverage %', w: 62, align: 'right' }, { title: 'Region', w: 70 }, { title: 'Why it is included', w: 180 }],
      members.map((m) => [m.role, m.organism, m.accession ?? '-', m.identityPct !== null ? `${m.identityPct} / ${m.coveragePct}` : '-', m.region ? `${m.region.from}-${m.region.to} ${m.region.strand}` : '-', (m.reasons ?? []).slice(0, 2).join('; ')]), { size: 7.8 });
    if (speciesOp?.result?.notes) { d.h2('Species added by name'); d.bullets(speciesOp.result.notes.map((n: any) => `"${n.name}": ${n.status === 'added' ? 'added' : n.status === 'not_found' ? 'not found in NCBI Taxonomy' : 'not added'} - ${n.detail}`)); }
    if (outgOp?.result) { const r = outgOp.result; d.h2('Outgroup assistant'); d.para(`${r.scopes ? `Ingroup clade: ${r.scopes.ingroup.name} (${r.scopes.ingroup.rank}); outgroups searched in ${r.scopes.outside.name} (${r.scopes.outside.rank}) excluding the ingroup. ` : ''}${r.entrez ? `NCBI query: ${r.entrez}. ` : ''}${r.candidates?.length ?? 0} candidate(s) proposed, ${r.excluded?.length ?? 0} rejected. Nothing was added without a person accepting it.`, { size: 9.5 }); for (const w of outgOp.warnings) d.para(`Note: ${w}`, { size: 9, color: BRAND.warn }); }
    if (relOp?.result?.excluded?.length) d.para(`${relOp.result.excluded.length} BLAST hit(s) were considered and rejected as relatives (reasons are stored with the operation and listed in the Markdown change log).`, { size: 9, color: BRAND.grey });
  }

  // ------------------------------------------------------------ 5 alignment
  d.h1('5  Multiple sequence alignment');
  if (!alOp?.result?.rows) d.para('No alignment has been made yet.');
  else {
    const r = alOp.result, roles: Record<string, string> = r.roles ?? {};
    d.kv([['Method', `${r.method ?? 'manual edit'}${alOp.tool ? ` (${alOp.tool})` : ''}`], ['Size', `${r.rows.length} sequences x ${r.length} columns; sum-of-pairs score ${r.spScore ?? '-'}; ${r.manualEdits ?? 0} manual edit(s)`], ['Settings', paramText(alOp.params)]], { keyW: 100 });
    const n = r.rows.length, rowH = Math.max(5, Math.min(11, 300 / n));
    d.figure(n * rowH + 40, (p, x, y, w) => { const used = strips(p, d, x, y, w, r.labels.map((l: string, i: number) => ({ label: members.find((m) => m.label === l)?.organism ?? l, seq: r.rows[i], tone: (roles[l] ?? members.find((m) => m.label === l)?.role) === 'query' ? 'query' : (roles[l] ?? members.find((m) => m.label === l)?.role) === 'outgroup' ? 'outgroup' : 'ingroup' })), { labelW: 150, rowH, conservation: true }); legend(p, d, x, y + used + 6); });
    d.para('Black bars above the alignment mark columns where every sequence has the same base; grey bars mark variable columns. The built-in aligner is a textbook progressive/iterative implementation, not MAFFT, MUSCLE or Clustal Omega.', { size: 9, color: BRAND.grey });
  }

  // ------------------------------------------------------------ 6 tree
  d.h1('6  Phylogenetic tree');
  let svg: string | null = null;
  if (!tr?.tree) d.para('No tree has been built yet.');
  else {
    const p = tr.params;
    d.kv([
      ['Method', `${String(tr.method).toUpperCase()}${tr.method === 'nj' || tr.method === 'upgma' || tr.method === 'me' ? `, ${p.distance} distances${p.gamma ? ` (gamma ${p.gamma})` : ''}` : tr.method === 'ml' ? `, ${p.mlModel}${p.mlGamma ? '+G4' : ''}` : ''}; gap treatment: ${p.gap?.mode ?? 'pairwise'}${p.gap?.cutoff !== undefined ? ` (${p.gap.cutoff}%)` : ''}`],
      ['Sites', `${tr.sitesKept} used of ${tr.sitesTotal} columns; ${tr.variableSites} variable, ${tr.informativeSites} parsimony-informative`],
      ['Support', tr.bootstrapDone ? `${tr.bootstrapDone} bootstrap replicates (seed ${p.seed}); numbers on branches are bootstrap percentages` : 'no bootstrap'],
      ['Rooting', tr.rooting], ...(tr.scoreName ? [[tr.scoreName, String(tr.score)] as [string, string]] : []),
    ], { keyW: 100 });
    const fig = buildTreeFigure(tr, members, F, d.cw);
    svg = figureToSvg(fig, { title: `Phylogenetic tree for ${name}` });
    d.figure(fig.h, (pg, x, y) => { for (const it of fig.items) { if (it.k === 'line') pg.line(x + it.x1, y + it.y1, x + it.x2, y + it.y2, { w: it.w, color: hex(it.c) }); else pg.text(x + it.x, y + it.y, it.s, { font: it.bold ? F.bold : F.regular, size: it.size, color: hex(it.c), anchor: it.anchor }); } });
    if (interp) {
      d.h2('How to read this tree'); d.para(interp.summary, { size: 10 });
      if (interp.closestRelatives?.length) d.table([{ title: 'Closest sequences by tree distance', w: 200 }, { title: 'Accession', w: 80 }, { title: 'Distance (subst./site)', w: 90, align: 'right' }], interp.closestRelatives.map((c: any) => [c.organism, c.accession ?? '-', String(c.distance)]));
      d.h2('Limitations'); d.bullets(interp.limitations);
    }
    for (const w of treeOp!.warnings) d.para(`Note: ${w}`, { size: 9, color: BRAND.warn });
  }

  // ------------------------------------------------------------ 7 identification
  d.h1('7  Final identification');
  if (!ident?.result) d.para('No identification has been recorded. Identification is the decision of a person who weighs the evidence above; VierStation never records one automatically.');
  else d.kv([['Conclusion', `${ident.result.taxon} (${ident.result.rank})${ident.result.taxId ? `, NCBI taxid ${ident.result.taxId}` : ''}`], ['Confidence', ident.result.confidence], ['Recorded by', `${ident.actorName ?? 'unknown'} on ${fmtT(ident.createdAt)}`], ['Notes', ident.result.notes || '-']], { keyW: 100 });

  // ------------------------------------------------------------ 8 history
  d.h1('8  Workflow history');
  d.para(`${ops.length} operation(s) logged; ${versions.length} sequence version(s) kept. Every operation records its parameters, tool, database source and who or what performed it.`, { size: 9.5, color: BRAND.grey });
  d.table([{ title: '#', w: 18 }, { title: 'Time (UTC)', w: 82 }, { title: 'Step', w: 52 }, { title: 'Operation', w: 190 }, { title: 'Status', w: 52 }, { title: 'By', w: 80 }], ops.map((x: Op, i) => [String(i + 1), fmtT(x.createdAt).replace(' UTC', ''), x.step, x.name, x.status, x.automatic ? 'VierStation (automatic)' : x.actorName ?? 'user']), { size: 7.8 });

  // ------------------------------------------------------------ 9 reproducibility
  d.h1('9  Reproducibility and limits');
  let notes: string[] = [], repro = '';
  try { const s = buildScript(recordId, { scope: 'workflow' }); notes = s.notes; repro = s.reproducible; } catch { /* script not available */ }
  const sources = [...new Set(ops.filter((x) => x.dbSource).map((x) => `${x.dbSource}${x.dbRetrievedAt ? ` (retrieved ${fmtT(x.dbRetrievedAt)})` : ''}`))];
  d.bullets([
    `The raw sequence is stored immutably (SHA-256 ${sha(st.raw.seq).slice(0, 16)}...). The exported Python workflow script re-applies the cleaning${mergeOp ? ' and the read merge' : ''} exactly and checks each result against the stored hash.`,
    `Overall reproducibility of the workflow script: ${repro || 'n/a'} - ${repro === 'exact' ? 'every step can be re-run exactly.' : 'steps that depend on NCBI (BLAST, record retrieval) or on VierStation\'s own engines can only be repeated approximately; the script says which and names the closest alternative.'}`,
    ...(sources.length ? [`Data sources: ${sources.join('; ')}.`] : []),
    'NCBI databases change over time: a BLAST repeated later can return different hits.',
    'VierStation\'s alignment and tree engines are standard textbook algorithms; they are not MEGA, BioEdit, CLC, MAFFT, IQ-TREE or similar programs, and results can differ from them.',
    ...notes.slice(0, 8),
  ], { size: 9 });
  return { pdf: d.save(), treeSvg: svg, pages: d.pages.length };
}

void normalise;
