// Synchronous Sequence Lab actions: quality inspection, chromatogram slices, manual dataset members, alignment edits, final identification, NCBI record preview/save.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { q } from '../db.ts';
import { bad, now } from '../util.ts';
import { reverseComplement } from '../../shared/sequence.ts';
import { Cancelled, Fatal, registerJob } from '../jobs.ts';
import { toCtx } from '../discovery/jobs.ts';
import { linkByTables, tableOfKind, upsertByKey } from '../ingest.ts';
import type { Ctx } from '../ingest.ts';
import { getRaw } from '../records.ts';
import { importNucleotide } from '../discovery/dna.ts';
import { cdsFrom, fetchFasta, fetchGenBank, genesFrom, nucSummary, taxonomyLineage } from '../integrations/ncbi.ts';
import { parseAb1 } from './formats.ts';
import type { Chromatogram } from './formats.ts';
import { IUPAC, codeFor, diffAgainstRaw } from './clean.ts';
import { latestOp, listOps, logOp, stateOf } from './store.ts';
import { currentDataset, editDataset, memberLabel, queryMember, recordName } from './dataset.ts';
import type { Member } from './dataset.ts';
import { defaultParams, kmerProfile, kmerSimilarity, pairwise } from '../analysis/align.ts';

// ---------------------------------------------------------------- inspection
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
export function inspect(recordId: string) {
  const st = stateOf(recordId); if (!st) throw bad('This record is not in the Sequence Lab.');
  const v = st.head, seq = v.seq;
  const counts: Record<string, number> = {};
  for (const c of seq) counts[c] = (counts[c] ?? 0) + 1;
  const acgt = (counts.A ?? 0) + (counts.C ?? 0) + (counts.G ?? 0) + (counts.T ?? 0);
  const ambiguous = Object.entries(counts).filter(([c]) => !'ACGT'.includes(c)).reduce((a, [, n]) => a + n, 0);
  const runs: { base: string; from: number; length: number }[] = [];
  for (let i = 0; i < seq.length;) { let j = i; while (j < seq.length && seq[j] === seq[i]) j++; if (j - i >= 8) runs.push({ base: seq[i], from: i + 1, length: j - i }); i = j; }
  const qual = v.qual;
  let quality: any = null; const suggestions: { op: string; params: Record<string, unknown>; why: string }[] = [];
  const lowRegions: { from: number; to: number; meanQ: number }[] = [];
  if (qual?.length) {
    const w = 10, means: number[] = [];
    for (let i = 0; i + w <= qual.length; i++) { let t = 0; for (let k = i; k < i + w; k++) t += qual[k]; means.push(t / w); }
    let start = -1;
    means.forEach((m, i) => { if (m < 20 && start < 0) start = i; if ((m >= 20 || i === means.length - 1) && start >= 0) { const end = m >= 20 ? i + w - 1 : i + w; lowRegions.push({ from: start + 1, to: end, meanQ: Math.round((qual.slice(start, end).reduce((a, b) => a + b, 0) / (end - start)) * 10) / 10 }); start = -1; } });
    quality = { mean: Math.round((qual.reduce((a, b) => a + b, 0) / qual.length) * 10) / 10, median: median(qual), min: Math.min(...qual), max: Math.max(...qual), q20Pct: Math.round((qual.filter((x) => x >= 20).length / qual.length) * 1000) / 10, q30Pct: Math.round((qual.filter((x) => x >= 30).length / qual.length) * 1000) / 10, values: qual.length <= 20000 ? qual : null };
    const lead = lowRegions.find((r) => r.from === 1), trail = lowRegions.find((r) => r.to >= qual.length - 1);
    if (lead || trail) suggestions.push({ op: 'trim_window', params: { op: 'trim_window', threshold: 20, window: 10, ends: 'both' }, why: `${lead ? 'The 5′ end' : ''}${lead && trail ? ' and ' : ''}${trail ? 'the 3′ end' : ''} have mean quality below Q20 in a 10-base window; Sanger reads are usually unreliable at both ends.` });
  }
  const ends = /^[^ACGT]/.test(seq) || /[^ACGT]$/.test(seq);
  if (ends) suggestions.push({ op: 'trim_ambiguous_ends', params: { op: 'trim_ambiguous_ends' }, why: 'The sequence starts or ends with ambiguous bases (N or IUPAC codes).' });
  if (ambiguous > 0 && !ends) suggestions.push({ op: 'remove_bases', params: { op: 'remove_bases', chars: 'N' }, why: `${ambiguous} ambiguous base(s) inside the sequence; decide whether to keep, correct from the chromatogram, or remove them.` });
  return {
    versionId: v.id, versionNumber: v.n, length: seq.length, gcPct: acgt ? Math.round((((counts.G ?? 0) + (counts.C ?? 0)) / acgt) * 1000) / 10 : null,
    counts, ambiguous, ambiguousPct: Math.round((ambiguous / seq.length) * 1000) / 10, homopolymers: runs.slice(0, 10), quality, lowQualityRegions: lowRegions, hasQuality: !!qual,
    source: (st.meta as any).source ?? null, fileName: (st.meta as any).fileName ?? null, hasChromatogram: !!chromatogramFile(recordId), suggestions,
    note: qual ? undefined : 'No per-base quality scores are available (FASTA or pasted sequence). Quality-based trimming is disabled; inspect by position, ambiguity and content instead.',
  };
}

// ---------------------------------------------------------------- chromatogram
const chromCache = new Map<string, Chromatogram>();
export function chromatogramFile(recordId: string): string | null {
  const st = stateOf(recordId); const id = (st?.meta as any)?.fileId; if (!id || (st!.meta as any).source !== 'ab1') return null;
  const p = join(config.filesDir, id); return existsSync(p) ? p : null;
}
export function loadChromatogram(recordId: string): Chromatogram {
  const p = chromatogramFile(recordId); if (!p) throw bad('No chromatogram file is stored for this record. Only AB1 imports include trace data.');
  const hit = chromCache.get(p); if (hit) return hit;
  const c = parseAb1(readFileSync(p)); chromCache.set(p, c); if (chromCache.size > 8) chromCache.delete(chromCache.keys().next().value!);
  return c;
}
/** A window of the raw chromatogram (bases from..to, 1-based, RAW coordinates) with how the current version treats each base. */
export function chromatogramSlice(recordId: string, from: number, to: number) {
  const c = loadChromatogram(recordId), st = stateOf(recordId)!;
  from = Math.max(1, Math.min(from, c.seq.length)); to = Math.max(from, Math.min(to, c.seq.length));
  if (to - from > 400) to = from + 400;
  const p0 = Math.max(0, (c.ploc[from - 1] ?? 0) - 8), p1 = Math.min(c.points - 1, (c.ploc[to - 1] ?? c.points) + 8);
  const head = st.head, kept = new Map<number, number>(); head.map?.forEach((r, i) => kept.set(r, i + 1));
  const rawNow = st.raw.seq;
  const bases = Array.from({ length: to - from + 1 }, (_, k) => {
    const i = from + k - 1, hp = kept.get(i);
    return { raw: i + 1, base: c.seq[i], q: c.qual[i] ?? null, x: (c.ploc[i] ?? 0) - p0, secondary: c.secondary[i], kept: hp !== undefined, headPos: hp ?? null, headBase: hp !== undefined ? head.seq[hp - 1] : null };
  });
  void rawNow;
  return { from, to, rawLength: c.seq.length, pointFrom: p0, pointTo: p1, traces: { A: c.traces.A.slice(p0, p1 + 1), C: c.traces.C.slice(p0, p1 + 1), G: c.traces.G.slice(p0, p1 + 1), T: c.traces.T.slice(p0, p1 + 1) }, bases, meta: c.meta,
    note: (() => { const r = (head.map ?? []).filter((x) => x >= 0); return r.length > 1 && r[0] > r[r.length - 1]; })() ? 'The working version is reverse-complemented; the chromatogram is shown in the original read orientation.' : undefined };
}
/** Positions where the second-highest peak is large: possible mixed bases. Suggestions only – nothing is changed. */
export function ambiguitySuggestions(recordId: string, minRatio = 0.4) {
  const c = loadChromatogram(recordId), st = stateOf(recordId)!; const kept = new Map<number, number>(); st.head.map?.forEach((r, i) => kept.set(r, i + 1));
  const out: { rawPos: number; headPos: number | null; called: string; second: string; ratio: number; suggested: string | null; q: number | null }[] = [];
  c.secondary.forEach((s, i) => {
    if (s.ratio < minRatio || !s.base || c.seq[i] === 'N') return;
    const code = codeFor(c.seq[i] + s.base);
    out.push({ rawPos: i + 1, headPos: kept.get(i) ?? null, called: c.seq[i], second: s.base, ratio: s.ratio, suggested: code, q: c.qual[i] ?? null });
  });
  return { minRatio, count: out.length, items: out.slice(0, 200), note: 'The second peak height relative to the called peak. High values can mean a mixed template (heterozygous or contaminated), a dye artefact or a noisy region; check the trace before accepting.' };
}

// ---------------------------------------------------------------- raw vs clean
export function compareRaw(recordId: string) {
  const st = stateOf(recordId); if (!st) throw bad('Not in the Sequence Lab');
  return { raw: st.raw.seq, current: st.head.seq, diff: diffAgainstRaw(st.raw.seq, { seq: st.head.seq, qual: st.head.qual, map: st.head.map, marks: st.head.marks }), marks: st.head.marks };
}

// ---------------------------------------------------------------- manual dataset members
export async function addAccession(recordId: string, userId: string | null, accession: string, role: 'ingroup' | 'outgroup', signal?: AbortSignal) {
  const sum = await nucSummary(accession.trim(), signal);
  if (!sum) throw bad(`Accession "${accession}" was not found in NCBI Nucleotide.`);
  if (sum.length > 30_000) throw bad(`${sum.accession} is ${sum.length.toLocaleString()} bp – too large to use as a reference. Add a smaller record or a region (accession and coordinates are not supported here; use a marker-specific record).`);
  const fa = await fetchFasta('nuccore', sum.accession, { signal });
  if (!fa) throw bad(`Could not retrieve the sequence of ${sum.accession}.`);
  let seq = fa.split('\n').filter((l) => !l.startsWith('>')).join('').toUpperCase().replace(/[^ACGTRYSWKMBDHVN]/g, '');
  const qm = queryMember(recordId).seq;
  // orient the reference like the query (k-mer similarity of forward vs reverse-complement)
  const kq = kmerProfile(qm, 7), fwd = kmerSimilarity(kq, kmerProfile(seq, 7)), rc = kmerSimilarity(kq, kmerProfile(reverseComplement(seq), 7));
  const reasons = [`Added manually by accession ${sum.accession}`];
  let strand: 'plus' | 'minus' = 'plus';
  if (rc > fwd * 1.5 && rc > 0.05) { seq = reverseComplement(seq); strand = 'minus'; reasons.push(`Reverse-complemented to match the query's orientation (k-mer similarity ${fwd.toFixed(2)} forward vs ${rc.toFixed(2)} reverse)`); }
  const organism = sum.organism ?? '';
  const lin = sum.taxId ? (await taxonomyLineage([sum.taxId], signal))[0] : undefined;
  const m: Member = { id: sum.accession, label: memberLabel(organism, sum.accession), accession: sum.accession, organism, taxId: sum.taxId ?? null, role, reasons, seq, region: { from: 1, to: sum.length, strand }, identityPct: null, coveragePct: null, bitScore: null, evalue: null, source: 'manual', lineage: lin?.lineage ?? [], title: sum.title };
  return editDataset(recordId, userId, `Added ${sum.accession} to the dataset`, { action: 'add_manual', member: m });
}

// ---------------------------------------------------------------- manual alignment editing
export type AlignEdit = { action: 'insert_gap'; label: string; col: number; n?: number } | { action: 'delete_gap'; label: string; col: number; n?: number };
export function editAlignment(recordId: string, userId: string | null, e: AlignEdit) {
  const a = latestOp(recordId, 'align_edit'), b = latestOp(recordId, 'align');
  const src = a && b && a.createdAt >= b.createdAt ? a : b;
  if (!src?.result?.rows) throw bad('Align the sequences first.');
  const labels: string[] = src.result.labels; let rows: string[] = src.result.rows.slice();
  const r = labels.indexOf(e.label); if (r < 0) throw bad('Unknown sequence');
  const n = Math.max(1, Math.min(50, e.n ?? 1)), col = Math.floor(e.col);
  if (col < 0 || col > rows[r].length) throw bad('Column out of range');
  const original = rows.map((x) => x.replace(/-/g, ''));
  let summary: string;
  if (e.action === 'insert_gap') {
    rows = rows.map((x, i) => (i === r ? x.slice(0, col) + '-'.repeat(n) + x.slice(col) : x + '-'.repeat(n)));
    summary = `Inserted ${n} gap(s) in ${e.label} before column ${col + 1}`;
  } else {
    if (col + n > rows[r].length || rows[r].slice(col, col + n) !== '-'.repeat(n)) throw bad('Only gap characters can be deleted – residues are never removed by alignment editing.');
    rows = rows.map((x, i) => (i === r ? x.slice(0, col) + x.slice(col + n) + '-'.repeat(n) : x));
    summary = `Deleted ${n} gap(s) in ${e.label} at column ${col + 1}`;
  }
  // drop columns that became all-gap
  const keep: number[] = []; for (let c = 0; c < rows[0].length; c++) if (rows.some((x) => x[c] !== '-')) keep.push(c);
  rows = rows.map((x) => keep.map((c) => x[c]).join(''));
  if (rows.some((x, i) => x.replace(/-/g, '') !== original[i])) throw bad('Internal check failed: the edit would change a sequence. Nothing was saved.');
  const edits = (src.result.manualEdits ?? 0) + 1;
  const id = logOp(recordId, { step: 'align_edit', name: 'Manual alignment edit', inputRef: src.id, params: e, tool: 'VierStation alignment editor', actor: userId, automatic: false, supersedes: src.id, result: { ...src.result, rows, length: rows[0].length, manualEdits: edits, edit: { summary, ...e }, method: `${src.result.method ?? ''} + manual edits`.replace(/^ \+ /, ''), iterations: undefined, conservation: undefined, consensus: undefined } });
  return { opId: id, summary, length: rows[0].length };
}

// ---------------------------------------------------------------- final identification
export function identify(recordId: string, userId: string | null, b: { taxon: string; rank: string; taxId?: number | null; confidence: 'high' | 'moderate' | 'low' | 'inconclusive'; notes?: string }) {
  const taxon = String(b.taxon ?? '').trim(); if (!taxon && b.confidence !== 'inconclusive') throw bad('Enter the taxon you conclude, or choose "inconclusive".');
  const blast = latestOp(recordId, 'blast'), tree = latestOp(recordId, 'tree');
  return logOp(recordId, {
    step: 'identify', name: b.confidence === 'inconclusive' ? 'Identification: inconclusive' : `Identification: ${taxon}`, inputRef: tree?.id ?? blast?.id ?? null, actor: userId, automatic: false, tool: 'User decision',
    params: { taxon, rank: b.rank, taxId: b.taxId ?? null, confidence: b.confidence },
    result: { taxon, rank: b.rank, taxId: b.taxId ?? null, confidence: b.confidence, notes: (b.notes ?? '').slice(0, 4000), basis: { blastOp: blast?.id ?? null, treeOp: tree?.id ?? null, topHit: blast?.result?.hits?.[0] ? { accession: blast.result.hits[0].accession, organism: blast.result.hits[0].organism, identityPct: blast.result.hits[0].identityPct, coveragePct: blast.result.hits[0].coveragePct } : null, treeSummary: tree?.result?.interpretation?.summary ?? null }, decidedAt: now() },
  });
}
export function identification(recordId: string) {
  const decided = latestOp(recordId, 'identify');
  const blast = latestOp(recordId, 'blast'), tree = latestOp(recordId, 'tree');
  const top = blast?.result?.hits?.[0];
  const evidence = {
    topHit: top ? { accession: top.accession, organism: top.organism, identityPct: top.identityPct, coveragePct: top.coveragePct, evalue: top.evalue, bitScore: top.bitScore } : null,
    tree: tree?.result?.interpretation ? { summary: tree.result.interpretation.summary, level: tree.result.interpretation.level, limitations: tree.result.interpretation.limitations } : null,
    dataset: (() => { const d = currentDataset(recordId); return d ? { members: d.dataset.members.length, outgroups: d.dataset.members.filter((m) => m.role === 'outgroup').length } : null; })(),
  };
  const missing: string[] = [];
  if (!blast) missing.push('NCBI BLAST similarity search'); if (!tree) missing.push('phylogenetic tree');
  return { decided: decided?.result ?? null, decidedOpId: decided?.id ?? null, evidence, missing, note: 'The system never concludes an identity on its own: evidence is summarised here and the conclusion is recorded as your decision.' };
}

// ---------------------------------------------------------------- full NCBI record
export async function previewNcbiRecord(accession: string, signal?: AbortSignal) {
  const sum = await nucSummary(accession.trim(), signal);
  if (!sum) throw bad(`Accession "${accession}" was not found in NCBI Nucleotide.`);
  if (sum.length > 5_000_000) throw bad(`${sum.accession} is ${sum.length.toLocaleString()} bp – too large to preview.`);
  const gb = await fetchGenBank(sum.accession, { signal, to: sum.length > 200_000 ? 200_000 : undefined });
  if (!gb) throw bad(`NCBI returned no GenBank record for ${sum.accession}`);
  const feat: Record<string, number> = {}; for (const f of gb.features) feat[f.type] = (feat[f.type] ?? 0) + 1;
  return {
    accession: gb.version || gb.accession, definition: gb.definition, organism: gb.organism, taxId: gb.taxId, lineage: gb.lineage, length: gb.length, molType: gb.molType, topology: gb.topology, division: gb.division, date: gb.date,
    source: gb.source, featureCounts: feat, genes: genesFrom(gb).slice(0, 20).map((g) => ({ symbol: g.symbol, location: g.location })), cds: cdsFrom(gb).slice(0, 20).map((c) => ({ product: c.product, proteinId: c.proteinId, location: c.location })),
    references: gb.references.slice(0, 20), dblink: gb.dblink, comment: gb.comment.slice(0, 1500), truncated: sum.length > 200_000,
    willSave: ['A new DNA record with the full sequence and GenBank metadata', 'Organism record with lineage', 'Genes found in the record (linked)', 'Provenance: NCBI Nucleotide, accession, retrieval date'],
    willNotSave: ['Nothing is saved until you confirm. Your query record is never modified by this action.'],
  };
}
registerJob('seq.save_reference', async (j) => {
  const { recordId, accession } = j.payload as { recordId: string; accession: string };
  const c = toCtx(j);
  const opId = logOp(recordId, { step: 'ncbi_record', name: `Fetch full NCBI record ${accession}`, params: { accession }, tool: 'VierStation + NCBI efetch', dbSource: 'NCBI Nucleotide', dbRetrievedAt: now(), actor: j.userId, automatic: false, status: 'running', jobId: j.id });
  try {
    if (j.signal.aborted) throw new Cancelled();
    const r = await importNucleotide(c, accession);
    q.run('UPDATE seq_ops SET status=?, result=?, output_ref=? WHERE id=?', 'completed', JSON.stringify({ accession: r.accession, savedRecordId: r.recordId, summary: `${r.classification.cls}` }), r.recordId, opId);
    return { recordId: r.recordId, accession: r.accession, summary: `Saved ${r.accession}`, _notify: { kind: 'fetch_completed' as const, title: `Saved NCBI record ${r.accession}`, link: `/record/${r.recordId}` } };
  } catch (e) {
    q.run('UPDATE seq_ops SET status=?, error=? WHERE id=?', e instanceof Cancelled ? 'cancelled' : 'failed', (e as Error).message, opId);
    throw e instanceof Cancelled ? e : e instanceof Fatal ? e : new Fatal((e as Error).message);
  }
});
export { IUPAC, listOps };

// ---------------------------------------------------------------- pairwise alignment (query vs one dataset member)
export function pairwiseWith(recordId: string, userId: string | null, memberId: string, p: { mode: 'global' | 'local'; match?: number; mismatch?: number; gapOpen?: number; gapExtend?: number }) {
  const ds = currentDataset(recordId); const m = ds?.dataset.members.find((x) => x.id === memberId);
  if (!m) throw bad('Choose a sequence from the dataset.');
  const q = queryMember(recordId);
  const params = { ...defaultParams('dna', p.mode), ...(p.match !== undefined ? { match: p.match } : {}), ...(p.mismatch !== undefined ? { mismatch: p.mismatch } : {}), ...(p.gapOpen !== undefined ? { gapOpen: p.gapOpen } : {}), ...(p.gapExtend !== undefined ? { gapExtend: p.gapExtend } : {}) };
  if (!(params.match > 0 && params.mismatch < 0 && params.gapOpen >= 0 && params.gapExtend >= 0)) throw bad('Use a positive match score, a negative mismatch score and non-negative gap penalties.');
  let a;
  try { a = pairwise(q.seq, m.seq, params); } catch (e) { throw bad((e as Error).message); }
  const result = { querySeq: q.seq, subjectSeq: m.seq, alignment: a, query: { label: q.label, length: q.seq.length }, subject: { id: m.id, label: m.label, organism: m.organism, accession: m.accession, length: m.seq.length }, summary: `${p.mode} alignment of the query with ${m.organism}${m.accession ? ` (${m.accession})` : ''}: ${a.identityPct}% identity over ${a.length} columns, ${a.gaps} gap column(s), score ${a.score}` };
  const opId = logOp(recordId, { step: 'pairwise', name: `Pairwise ${p.mode} alignment with ${m.organism}`, inputRef: ds!.op.id, params: { ...params, subject: m.id }, tool: 'VierStation Gotoh aligner (affine gaps)', actor: userId, automatic: false, result });
  return { opId, ...result };
}

/**
 * After the user records a conclusion: link the sequence to the Organism record of that taxon. The link is classed "user supplied" – it states the user's
 * conclusion, not a database confirmation – and points back to the history operation that recorded it.
 */
export async function linkIdentification(recordId: string, userId: string | null, o: { taxId: number; name: string; rank: string; confidence: string; opId: string }) {
  const rec = getRaw(recordId); if (!rec) throw bad('Record not found');
  const t = q.get<{ workspace_id: string; project_id: string | null }>('SELECT workspace_id, project_id FROM tables WHERE id=?', rec.tableId)!;
  const c: Ctx = { workspaceId: t.workspace_id, projectId: t.project_id, userId, log: () => {}, origin: { jobId: 'seqlab', depth: 3 } };
  const lin = (await taxonomyLineage([o.taxId]))[0];
  const orgTable = tableOfKind(c, 'organism');
  const org = upsertByKey(c, orgTable, 'taxid', String(o.taxId), { name: lin?.name ?? o.name, taxid: String(o.taxId), lineage: lin ? lin.lineage.filter((n) => n.rank !== 'no rank' || n.name === 'cellular organisms').map((n) => n.name).join('; ') : undefined }, { sourceDb: 'NCBI Taxonomy', accession: String(o.taxId), url: `https://www.ncbi.nlm.nih.gov/datasets/taxonomy/${o.taxId}/`, step: 'identification' });
  const linked = linkByTables(rec.tableId, recordId, orgTable, org.id, { evidenceClass: 'user_supplied', evidence: `Identified by the user as ${o.name} (${o.rank}), confidence: ${o.confidence}. This is the user's conclusion from BLAST and phylogenetic evidence, not a database-confirmed identity. See workflow history operation ${o.opId}.`, sourceDb: 'VierStation Sequence Lab', relationType: 'identified as (user conclusion)' });
  return { organismRecordId: org.id, linked };
}
