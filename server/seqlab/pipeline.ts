// Sequence Lab background jobs: BLAST → relatives → outgroups → alignment → tree. Each job logs ONE operation (running → completed/failed/cancelled)
// with its parameters, inputs, tool, database source and retrieval date, so the workflow history is a faithful record of what ran.
import { Cancelled, Fatal, hooks, registerJob } from '../jobs.ts';
import type { JobCtx } from '../jobs.ts';
import { now } from '../util.ts';
import { blastRun, fetchFasta, taxonomyByName, taxonomyLineage } from '../integrations/ncbi.ts';
import type { BlastHit, BlastHsp, TaxLineage } from '../integrations/ncbi.ts';
import { getOp, latestOp, logOp, stateOf, updateOp } from './store.ts';
import { currentDataset, genusOf, memberLabel, queryMember, rankName, recordName, saveDataset } from './dataset.ts';

hooks.subject = (id) => { const n = recordName(id); return n === id ? null : n; };
import type { Dataset, Member } from './dataset.ts';
import { columnSummary, defaultMsa, spScore } from './msa.ts';
import { detectAligners, runExternal } from './external.ts';
import type { MsaOptions, MsaRun } from './msa.ts';
import { runTask } from './pool.ts';
import { DEFAULT_PARAMS } from '../phylo/run.ts';
import type { PhyloParams, PhyloResult } from '../phylo/run.ts';
import { interpretTree } from './interpret.ts';

/** Records whose name does not identify a species: uncultured / environmental / synthetic entries and placeholders such as "Escherichia sp.", "marine bacterium", "bacterium BM0595". */
export const ENV_RE = /uncultured|environmental sample|metagenom|synthetic construct|unidentified|unclassified|cloning vector|\bvector\b|(^|\s)(bacterium|archaeon|sp\.|cf\.|aff\.|gen\.|symbiont|endosymbiont|endophyte|endophytic|fungus|fungal)(\s|$)/i;

// ---------------------------------------------------------------- BLAST hits (normalised)
export interface LabHsp { bitScore: number; evalue: number; identityPct: number; alignLen: number; mismatches: number; gaps: number; queryFrom: number; queryTo: number; hitFrom: number; hitTo: number; strand: string; qseq?: string; hseq?: string; midline?: string }
export interface LabHit {
  accession: string; title: string; organism: string; taxId: number | null; length: number; bitScore: number; evalue: number; identityPct: number; coveragePct: number;
  alignLen: number; mismatches: number; gaps: number; strand: string; hsps: LabHsp[]; environmental: boolean;
}
const pct = (x: number) => Math.round(x * 100) / 100;
export function normaliseHit(h: BlastHit, queryLen: number, keepAlignments: boolean): LabHit {
  const hsps: LabHsp[] = h.hsps.slice().sort((a, b) => b.bitScore - a.bitScore).slice(0, 3).map((x: BlastHsp, i) => ({
    bitScore: x.bitScore, evalue: x.evalue, identityPct: x.alignLen ? pct((x.identity / x.alignLen) * 100) : 0, alignLen: x.alignLen, mismatches: x.mismatches, gaps: x.gaps,
    queryFrom: x.queryFrom, queryTo: x.queryTo, hitFrom: x.hitFrom, hitTo: x.hitTo, strand: x.strand, ...(keepAlignments && i === 0 ? { qseq: x.qseq, hseq: x.hseq, midline: x.midline } : {}),
  }));
  const best = hsps[0];
  void queryLen;
  return {
    accession: h.accession, title: h.title, organism: h.organism, taxId: h.taxId, length: h.length, bitScore: best?.bitScore ?? 0, evalue: best?.evalue ?? 1, identityPct: best?.identityPct ?? 0,
    coveragePct: pct(h.queryCoveragePct), alignLen: best?.alignLen ?? 0, mismatches: best?.mismatches ?? 0, gaps: best?.gaps ?? 0, strand: best?.strand ?? 'Plus', hsps, environmental: ENV_RE.test(`${h.title} ${h.organism}`),
  };
}

/** Filters + transparent ranking applied to stored hits (read-time: the stored result is never altered). */
export interface HitFilter { minIdentity?: number; minCoverage?: number; maxEvalue?: number; text?: string; excludeEnvironmental?: boolean; onePerSpecies?: boolean; sort?: 'bitScore' | 'identity' | 'coverage' | 'evalue' | 'combined'; limit?: number }
export const RANKING_EXPLANATION: Record<string, string> = {
  bitScore: 'Sorted by BLAST bit score (higher = stronger local alignment; independent of database size).',
  identity: 'Sorted by percent identity of the best alignment segment, then bit score. Identity alone ignores how much of your sequence was covered.',
  coverage: 'Sorted by query coverage, then identity. Coverage alone ignores how similar the covered part is.',
  evalue: 'Sorted by E-value (lower = less likely to arise by chance), then bit score.',
  combined: 'Sorted by identity × coverage ÷ 100 (a simple combined score VierStation computes; BLAST itself does not provide it), then bit score.',
};
export function rankHits(hits: LabHit[], f: HitFilter): LabHit[] {
  let out = hits.filter((h) => (f.minIdentity === undefined || h.identityPct >= f.minIdentity) && (f.minCoverage === undefined || h.coveragePct >= f.minCoverage) && (f.maxEvalue === undefined || h.evalue <= f.maxEvalue) && (!f.excludeEnvironmental || !h.environmental));
  if (f.text) { const t = f.text.toLowerCase(); out = out.filter((h) => `${h.organism} ${h.title} ${h.accession}`.toLowerCase().includes(t)); }
  const key = f.sort ?? 'bitScore';
  const cmp: Record<string, (a: LabHit, b: LabHit) => number> = {
    bitScore: (a, b) => b.bitScore - a.bitScore, identity: (a, b) => b.identityPct - a.identityPct || b.bitScore - a.bitScore, coverage: (a, b) => b.coveragePct - a.coveragePct || b.identityPct - a.identityPct,
    evalue: (a, b) => a.evalue - b.evalue || b.bitScore - a.bitScore, combined: (a, b) => (b.identityPct * b.coveragePct) - (a.identityPct * a.coveragePct) || b.bitScore - a.bitScore,
  };
  out = out.slice().sort(cmp[key] ?? cmp.bitScore);
  if (f.onePerSpecies) { const seen = new Set<string>(); out = out.filter((h) => { const k = h.taxId ? `t${h.taxId}` : h.organism; if (seen.has(k)) return false; seen.add(k); return true; }); }
  return f.limit ? out.slice(0, f.limit) : out;
}

const guard = (j: JobCtx) => { if (j.signal.aborted) throw new Cancelled(); };

/** Run a job body as a logged operation: status running → completed / failed / cancelled. */
export async function asOp<T>(j: JobCtx, recordId: string, spec: Parameters<typeof logOp>[1], body: (opId: string) => Promise<{ result: unknown; warnings?: string[]; outputRef?: string | null; value: T }>): Promise<T> {
  const opId = logOp(recordId, { ...spec, actor: j.userId, jobId: j.id, status: 'running', automatic: spec.automatic ?? false, supersedes: latestOp(recordId, spec.step)?.id });
  try {
    const r = await body(opId);
    updateOp(opId, { result: r.result, status: 'completed', warnings: r.warnings, outputRef: r.outputRef });
    return r.value;
  } catch (e) {
    const cancelled = e instanceof Cancelled || (e as Error).message === 'Cancelled' || j.signal.aborted;
    updateOp(opId, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'Cancelled by the user' : (e as Error).message });
    throw cancelled ? new Cancelled() : e;
  }
}

// ---------------------------------------------------------------- BLAST
export interface BlastParams { db: string; program: 'megablast' | 'blastn'; hitlist: number; expect: number; entrez?: string }
export const DEFAULT_BLAST: BlastParams = { db: 'core_nt', program: 'megablast', hitlist: 50, expect: 0.05 };

registerJob('seq.blast', async (j) => {
  const { recordId } = j.payload as { recordId: string };
  const params: BlastParams = { ...DEFAULT_BLAST, ...(j.payload.params ?? {}) };
  const st = stateOf(recordId);
  if (!st) throw new Fatal('This record is not in the Sequence Lab.');
  const query = st.head.seq.replace(/-/g, '');
  if (query.length < 20) throw new Fatal('The sequence is shorter than 20 bases – too short for a meaningful BLAST search.');
  if (query.length > 20000) throw new Fatal('The sequence is longer than 20 kb – trim it to the marker region before BLAST.');
  return asOp(j, recordId, { step: 'blast', name: 'NCBI BLAST similarity search', inputRef: st.head.id, params: { ...params, queryLength: query.length }, tool: 'NCBI BLAST URL API (blastn)', dbSource: `NCBI BLAST ${params.db}` }, async () => {
    j.progress(0, null, 'Submitting to NCBI BLAST');
    const res = await blastRun(query, { db: params.db, program: 'blastn', megablast: params.program === 'megablast', hitlist: params.hitlist, expect: params.expect, entrez: params.entrez, signal: j.signal, onWait: (m) => { j.log(m); j.progress(0, null, m); } });
    guard(j);
    const hits = res.hits.map((h, i) => normaliseHit(h, query.length, i < 25));
    const retrievedAt = now();
    const top = hits[0];
    const summary = top ? `${hits.length} hit(s). Top: ${top.organism} (${top.accession}), ${top.identityPct}% identity over ${top.coveragePct}% of the query, E=${top.evalue}.` : 'BLAST found no significant similarity.';
    return { result: { rid: res.rid, db: res.db, queryLength: res.queryLength, hits, summary, retrievedAt }, value: { opHits: hits.length, summary, _notify: { kind: 'analysis_completed' as const, title: 'BLAST finished', body: summary, link: `/lab/${recordId}?section=matches` } } };
  });
}, { maxAttempts: 2 });

// ---------------------------------------------------------------- region retrieval
export interface RegionFetch { seq: string; region: { from: number; to: number; strand: 'plus' | 'minus' } }
/** The part of the subject that BLAST aligned to the query, returned in the QUERY's orientation. */
export async function fetchHitRegion(hit: LabHit, queryLen: number, signal: AbortSignal): Promise<RegionFetch | null> {
  const best = hit.hsps[0]; if (!best) return null;
  const minus = best.strand === 'Minus' || best.hitFrom > best.hitTo;
  const same = hit.hsps.filter((h) => (h.strand === 'Minus' || h.hitFrom > h.hitTo) === minus);
  const lo = Math.min(...same.flatMap((h) => [h.hitFrom, h.hitTo])), hi = Math.max(...same.flatMap((h) => [h.hitFrom, h.hitTo]));
  let from = lo, to = hi;
  if (hi - lo + 1 > 2 * queryLen + 200) { from = Math.min(best.hitFrom, best.hitTo); to = Math.max(best.hitFrom, best.hitTo); }
  const fa = await fetchFasta('nuccore', hit.accession, { from, to, strand: minus ? 2 : 1, signal });
  if (!fa) return null;
  const seq = fa.split('\n').filter((l) => !l.startsWith('>')).join('').toUpperCase().replace(/[^ACGTRYSWKMBDHVN]/g, '');
  if (seq.length < 20) return null;
  return { seq, region: { from, to, strand: minus ? 'minus' : 'plus' } };
}

function asMember(h: LabHit, r: RegionFetch, role: Member['role'], reasons: string[], lineage: TaxLineage | undefined, source: Member['source']): Member {
  return {
    id: h.accession, label: memberLabel(h.organism, h.accession), accession: h.accession, organism: h.organism, taxId: h.taxId, role, reasons, seq: r.seq, region: r.region,
    identityPct: h.identityPct, coveragePct: h.coveragePct, bitScore: h.bitScore, evalue: h.evalue, source, lineage: lineage?.lineage ?? [], title: h.title,
  };
}

async function lineagesFor(taxIds: (number | null)[], signal: AbortSignal): Promise<Map<number, TaxLineage>> {
  const ids = [...new Set(taxIds.filter((x): x is number => !!x))];
  const out = new Map<number, TaxLineage>();
  for (const l of await taxonomyLineage(ids, signal)) out.set(l.taxId, l);
  return out;
}

// ---------------------------------------------------------------- close relatives
export interface RelativesParams { blastOpId?: string; only?: string[]; /** also run a taxon-restricted BLAST in the best match's genus to bring in species that are not among the top hits */ broaden?: boolean; broadenMax?: number; maxRelatives: number; minCoverage: number; minIdentity: number; maxPerGenus: number; excludeEnvironmental: boolean; minLength?: number }
export const DEFAULT_RELATIVES: RelativesParams = { maxRelatives: 10, minCoverage: 80, minIdentity: 70, maxPerGenus: 4, excludeEnvironmental: true };

registerJob('seq.relatives', async (j) => {
  const { recordId } = j.payload as { recordId: string };
  const params: RelativesParams = { ...DEFAULT_RELATIVES, ...(j.payload.params ?? {}) };
  const blastOp = params.blastOpId ? getOp(params.blastOpId) : latestOp(recordId, 'blast');
  if (!blastOp || blastOp.status !== 'completed' || !blastOp.result?.hits) throw new Fatal('Run an NCBI BLAST search first – the closest relatives are chosen from its hits.');
  const hits: LabHit[] = blastOp.result.hits, qLen: number = blastOp.result.queryLength;
  const prev = currentDataset(recordId);
  return asOp(j, recordId, { step: 'relatives', name: 'Retrieve close relatives', inputRef: blastOp.id, params, tool: 'VierStation selection + NCBI efetch/taxonomy', dbSource: 'NCBI Nucleotide, NCBI Taxonomy' }, async () => {
    const excluded: { accession: string; organism: string; reason: string }[] = [];
    // 1. rule-based pre-selection (every rejection is recorded with its reason)
    const ok: LabHit[] = [];
    const seenSpecies = new Set<string>(), seenAcc = new Set<string>();
    for (const h of hits.slice().sort((a, b) => b.bitScore - a.bitScore)) {
      if (params.only) { if (!params.only.includes(h.accession) || seenAcc.has(h.accession)) continue; seenAcc.add(h.accession); ok.push(h); continue; } // the user picked these hits: no automatic thresholds
      const why = params.excludeEnvironmental && h.environmental ? 'uncultured / environmental / synthetic / unresolved name (no species epithet)'
        : h.coveragePct < params.minCoverage ? `query coverage ${h.coveragePct}% < ${params.minCoverage}%`
        : h.identityPct < params.minIdentity ? `identity ${h.identityPct}% < ${params.minIdentity}%`
        : seenAcc.has(h.accession.replace(/\.\d+$/, '')) ? 'duplicate accession'
        : seenSpecies.has(h.taxId ? `t${h.taxId}` : h.organism) ? 'another sequence of the same species was already selected (one per species)' : null;
      if (why) { excluded.push({ accession: h.accession, organism: h.organism, reason: why }); continue; }
      seenAcc.add(h.accession.replace(/\.\d+$/, '')); seenSpecies.add(h.taxId ? `t${h.taxId}` : h.organism); ok.push(h);
    }
    if (!ok.length) throw new Fatal(`No BLAST hit passed the filters (coverage ≥ ${params.minCoverage}%, identity ≥ ${params.minIdentity}%). Lower the thresholds or check the sequence.`);
    // 2. taxonomy for the shortlist, genus cap, final choice
    j.progress(0, null, 'Reading NCBI taxonomy');
    const shortlist = ok.slice(0, Math.min(60, params.maxRelatives * 5)); // distinct taxon ids; strains of one species are merged below once their lineage is known
    const lin = await lineagesFor(shortlist.map((h) => h.taxId), j.signal);
    guard(j);
    const genusCount = new Map<string, number>(), chosen: LabHit[] = [], speciesSeen = new Set<string>();
    for (const h of shortlist) {
      const spNode = (lin.get(h.taxId ?? -1)?.lineage ?? []).find((n) => n.rank === 'species');
      const spKey = spNode ? `t${spNode.taxId}` : h.taxId ? `t${h.taxId}` : h.organism;
      if (speciesSeen.has(spKey)) { excluded.push({ accession: h.accession, organism: h.organism, reason: `another sequence of the same species (${spNode?.name ?? h.organism}) was already selected (one per species; strains are merged)` }); continue; }
      const g = rankName({ lineage: lin.get(h.taxId ?? -1)?.lineage ?? [] }, 'genus') ?? genusOf(h.organism);
      if ((genusCount.get(g) ?? 0) >= params.maxPerGenus) { excluded.push({ accession: h.accession, organism: h.organism, reason: `genus ${g} already has ${params.maxPerGenus} representatives (cap keeps the dataset taxonomically balanced)` }); continue; }
      genusCount.set(g, (genusCount.get(g) ?? 0) + 1); speciesSeen.add(spKey); chosen.push(h);
      if (chosen.length >= params.maxRelatives) break;
    }
    for (const h of shortlist.slice(shortlist.indexOf(chosen[chosen.length - 1]) + 1)) excluded.push({ accession: h.accession, organism: h.organism, reason: `beyond the requested ${params.maxRelatives} relatives` });
    // 3. retrieve the homologous region of each choice
    const best = chosen[0], bestLin = lin.get(best.taxId ?? -1);
    const members: Member[] = [];
    let done = 0;
    for (const h of chosen) {
      guard(j);
      j.progress(done, chosen.length, `Retrieving region of ${h.accession}`);
      let reg: RegionFetch | null = null;
      try { reg = await fetchHitRegion(h, qLen, j.signal); } catch (e) { if (e instanceof Cancelled) throw e; j.log(`Could not retrieve ${h.accession}: ${(e as Error).message}`, 'warn'); }
      done++;
      if (!reg) { excluded.push({ accession: h.accession, organism: h.organism, reason: 'the aligned region could not be retrieved from NCBI' }); continue; }
      const hl = lin.get(h.taxId ?? -1);
      const reasons = [`BLAST hit: ${h.identityPct}% identity over ${h.coveragePct}% of the query (E=${h.evalue}, bit score ${h.bitScore})`];
      if (params.only) reasons.unshift('Selected by you from the BLAST hit list');
      if (h === best) reasons.unshift('Best BLAST match');
      else if (bestLin && hl) {
        const shared = ['genus', 'family', 'order', 'class'].find((r) => rankName({ lineage: bestLin.lineage }, r) && rankName({ lineage: bestLin.lineage }, r) === rankName({ lineage: hl.lineage }, r));
        reasons.push(shared ? `Same ${shared} as the best match (${rankName({ lineage: hl.lineage }, shared)})` : 'Different lineage from the best match');
      }
      reasons.push('Region = the part of this record that BLAST aligned to your query, returned in the query\'s orientation');
      const m = asMember(h, reg, 'ingroup', reasons, hl, 'blast');
      if (members.some((x) => x.seq === m.seq && x.organism === m.organism)) { excluded.push({ accession: h.accession, organism: h.organism, reason: 'identical sequence from the same species' }); continue; }
      members.push(m);
    }
    // 3b. optional taxonomy-based broadening: other species of the best match's genus that the top hits did not reach
    const rounds: { entrez: string; rid: string; hits: number; added: number }[] = [];
    const genusNode = bestLin?.lineage.find((n) => n.rank === 'genus');
    if (params.broaden && !params.only && genusNode) {
      guard(j);
      const speciesIds = [...new Set(members.map((m) => m.lineage.find((l) => l.rank === 'species')?.taxId ?? m.taxId).filter((x): x is number => !!x))].slice(0, 12);
      const entrez = `txid${genusNode.taxId}[Organism:exp]${speciesIds.map((t) => ` NOT txid${t}[Organism:exp]`).join('')}`;
      j.progress(0, null, `Searching other species of ${genusNode.name}`);
      const res = await blastRun(stateOf(recordId)!.head.seq.replace(/-/g, ''), { db: 'core_nt', program: 'blastn', megablast: false, hitlist: 100, expect: 1, entrez, signal: j.signal, onWait: (m) => { j.log(m); j.progress(0, null, m); } });
      guard(j);
      const more = res.hits.map((h) => normaliseHit(h, qLen, false)).sort((a, b) => b.bitScore - a.bitScore);
      const okMore = more.filter((h) => { const why = params.excludeEnvironmental && h.environmental ? 'uncultured / environmental / synthetic / unresolved name (no species epithet)' : h.coveragePct < params.minCoverage ? `query coverage ${h.coveragePct}% < ${params.minCoverage}%` : h.identityPct < params.minIdentity ? `identity ${h.identityPct}% < ${params.minIdentity}%` : seenAcc.has(h.accession.replace(/\.\d+$/, '')) ? 'duplicate accession' : null; if (why) excluded.push({ accession: h.accession, organism: h.organism, reason: `genus search: ${why}` }); return !why; });
      const linMore = await lineagesFor(okMore.slice(0, 40).map((h) => h.taxId), j.signal);
      const added: LabHit[] = [];
      for (const h of okMore.slice(0, 40)) {
        const spNode = (linMore.get(h.taxId ?? -1)?.lineage ?? []).find((n) => n.rank === 'species');
        const spKey = spNode ? `t${spNode.taxId}` : h.taxId ? `t${h.taxId}` : h.organism;
        if (speciesSeen.has(spKey)) { excluded.push({ accession: h.accession, organism: h.organism, reason: `genus search: another sequence of ${spNode?.name ?? h.organism} was already selected` }); continue; }
        speciesSeen.add(spKey); added.push(h);
        if (added.length >= (params.broadenMax ?? 5)) break;
      }
      let k = 0;
      for (const h of added) {
        guard(j); j.progress(k++, added.length, `Retrieving region of ${h.accession}`);
        let reg: RegionFetch | null = null;
        try { reg = await fetchHitRegion(h, qLen, j.signal); } catch (e) { if (e instanceof Cancelled) throw e; j.log(`Could not retrieve ${h.accession}: ${(e as Error).message}`, 'warn'); }
        if (!reg) { excluded.push({ accession: h.accession, organism: h.organism, reason: 'genus search: the aligned region could not be retrieved' }); continue; }
        const hl = linMore.get(h.taxId ?? -1);
        members.push(asMember(h, reg, 'ingroup', [`Another species of ${genusNode.name} found by a taxon-restricted BLAST (it was not among the top hits): ${h.identityPct}% identity over ${h.coveragePct}% of the query`, `Same genus as the best match (${genusNode.name})`, 'Region = the part of this record that BLAST aligned to your query, returned in the query\'s orientation'], hl, 'taxon_blast'));
      }
      rounds.push({ entrez, rid: res.rid, hits: more.length, added: added.length });
    }
    if (!members.length) throw new Fatal('None of the selected records could be retrieved from NCBI. Try again later.');
    const kept = prev?.dataset.members.filter((m) => m.role === 'outgroup') ?? [];
    const warnings: string[] = [];
    if (members.length < params.maxRelatives) warnings.push(`Only ${members.length} relative(s) were available after filtering (requested ${params.maxRelatives}). The BLAST search listed ${hits.length} hit(s); many of them can belong to the same few species. Raise "Max hits" in the NCBI search, or restrict it to the family with an Entrez query such as txid<taxon id>[Organism:exp], to bring in more species.`);
    if (kept.length) warnings.push(`${kept.length} outgroup(s) from the previous dataset were kept.`);
    const dsId = saveDataset(recordId, j.userId, 'Dataset: close relatives', { from: blastOp.id, ...params }, [queryMember(recordId), ...members, ...kept], { automatic: false, jobId: j.id, tool: 'VierStation', extra: { excluded, rounds, source: 'relatives' }, basis: { blastOpId: blastOp.id }, dbSource: 'NCBI Nucleotide', dbRetrievedAt: now() });
    return { result: { kept: members.length, excluded, rounds, bestMatch: { accession: best.accession, organism: best.organism }, dataset: dsId }, warnings, outputRef: dsId, value: { kept: members.length, excluded: excluded.length, _notify: { kind: 'analysis_completed' as const, title: `Dataset ready: ${members.length} close relatives`, link: `/lab/${recordId}?section=relatives` } } };
  });
}, { maxAttempts: 2 });

// ---------------------------------------------------------------- species typed by name
export interface SpeciesParams { names: string[]; role: 'ingroup' | 'outgroup'; minCoverage: number; hitlist: number }
export const DEFAULT_SPECIES: SpeciesParams = { names: [], role: 'ingroup', minCoverage: 15, hitlist: 20 };

/**
 * "Collect the DNA of these species": for each typed name → NCBI Taxonomy (exact scientific name, then synonym/common name) →
 * BLAST of YOUR sequence restricted to that taxon (txid…[Organism:exp]) → the best non-environmental hit → the region of that record that BLAST aligned
 * to your sequence, fetched in the query's orientation. So the sequence collected for each species is the homologous marker region, not an arbitrary record.
 */
registerJob('seq.add_species', async (j) => {
  const { recordId } = j.payload as { recordId: string };
  const params: SpeciesParams = { ...DEFAULT_SPECIES, ...(j.payload.params ?? {}) };
  const names = [...new Set(params.names.map((n) => n.trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 12);
  if (!names.length) throw new Fatal('Type at least one species name.');
  const st = stateOf(recordId); if (!st) throw new Fatal('This record is not in the Sequence Lab.');
  const query = st.head.seq.replace(/-/g, '');
  if (query.length < 20) throw new Fatal('The sequence is shorter than 20 bases – too short for a meaningful search.');
  const bp = latestOp(recordId, 'blast')?.params ?? {};
  const db = String(bp.db ?? 'core_nt'), megablast = bp.program ? bp.program === 'megablast' : true, expect = Math.max(Number(bp.expect ?? 0.05), 1);
  const prev = currentDataset(recordId);
  type Note = { name: string; status: 'added' | 'skipped' | 'not_found'; detail: string; taxId?: number; accession?: string; entrez?: string; rid?: string };
  return asOp(j, recordId, { step: 'species', name: `Add species by name (${names.join(', ')})`, inputRef: st.head.id, params: { ...params, names, db, program: megablast ? 'megablast' : 'blastn', expect }, tool: 'VierStation + NCBI Taxonomy + NCBI BLAST (taxon-restricted)', dbSource: `NCBI Taxonomy, NCBI BLAST ${db}, NCBI Nucleotide` }, async () => {
    const members: Member[] = [], notes: Note[] = [], warnings: string[] = [];
    const have = new Set((prev?.dataset.members ?? []).flatMap((m) => [m.taxId, ...m.lineage.filter((l) => l.rank === 'species').map((l) => l.taxId)]).filter((x): x is number => !!x));
    let k = 0;
    for (const name of names) {
      guard(j); j.progress(k++, names.length, `Looking up ${name}`);
      const found = await taxonomyByName(name, j.signal);
      if (found.unavailable) { notes.push({ name, status: 'skipped', detail: 'NCBI Taxonomy did not answer (it returned server errors on every attempt). This says nothing about whether the name exists - run the request again in a few minutes.' }); continue; }
      if (!found.taxa.length) { notes.push({ name, status: 'not_found', detail: 'No taxon with this name in NCBI Taxonomy (check the spelling; use the scientific name, e.g. "Trichoderma harzianum").' }); continue; }
      const tx = found.taxa[0];
      const sp = tx.lineage.find((l) => l.rank === 'species')?.taxId ?? tx.taxId;
      if (have.has(tx.taxId) || have.has(sp)) { notes.push({ name, status: 'skipped', taxId: tx.taxId, detail: `${tx.name} (taxid ${tx.taxId}) is already in the dataset.` }); continue; }
      const entrez = `txid${tx.taxId}[Organism:exp]`;
      j.progress(k - 1, names.length, `BLAST of your sequence inside ${tx.name}`);
      const res = await blastRun(query, { db, program: 'blastn', megablast, hitlist: params.hitlist, expect, entrez, signal: j.signal, onWait: (m) => { j.log(m); j.progress(k - 1, names.length, m); } });
      guard(j);
      const hits = res.hits.map((h) => normaliseHit(h, query.length, false)).sort((a, b) => b.bitScore - a.bitScore);
      const best = hits.filter((h) => !h.environmental && h.coveragePct >= params.minCoverage)[0];
      if (!best) { notes.push({ name, status: 'skipped', taxId: tx.taxId, entrez, rid: res.rid, detail: hits.length ? `${tx.name}: ${hits.length} BLAST hit(s) inside the taxon, but none passed (named species, query coverage ≥ ${params.minCoverage}%). The best was ${hits[0].organism} with ${hits[0].coveragePct}% coverage.` : res.dbSequences === 0 ? `${tx.name}: NCBI reported that the restriction matched no database sequences on all 3 attempts. This is often a temporary NCBI problem rather than proof that nothing is deposited - run it again later.` : `${tx.name}: BLAST found no sequence similar to yours inside this taxon (the marker may not be deposited for it, or your sequence is too short or too ambiguous to match).` }); continue; }
      let reg: RegionFetch | null = null;
      try { reg = await fetchHitRegion(best, query.length, j.signal); } catch (e) { if (e instanceof Cancelled) throw e; j.log(`Could not retrieve ${best.accession}: ${(e as Error).message}`, 'warn'); }
      if (!reg) { notes.push({ name, status: 'skipped', taxId: tx.taxId, accession: best.accession, entrez, rid: res.rid, detail: `The aligned region of ${best.accession} could not be retrieved from NCBI.` }); continue; }
      const lin = (await lineagesFor([best.taxId], j.signal)).get(best.taxId ?? -1) ?? tx;
      const reasons = [
        `Added because you typed "${name}" → NCBI Taxonomy ${tx.name} (taxid ${tx.taxId}, rank ${tx.rank}; matched by ${found.via})`,
        `Best BLAST hit of your sequence inside that taxon (${entrez}): ${best.organism} ${best.accession}, ${best.identityPct}% identity over ${best.coveragePct}% of the query, E=${best.evalue}, bit score ${best.bitScore}`,
        'Region = the part of this record that BLAST aligned to your sequence, returned in the query\'s orientation',
      ];
      if (tx.rank !== 'species') reasons.push(`"${name}" is a ${tx.rank}, not a species: the sequence of the most similar member of it was taken`);
      if (best.coveragePct < 50) warnings.push(`${tx.name}: only ${best.coveragePct}% of your sequence aligns to ${best.accession}, so this reference covers a short region.`);
      members.push(asMember(best, reg, params.role, reasons, lin, 'species_name'));
      have.add(tx.taxId); have.add(sp);
      notes.push({ name, status: 'added', taxId: tx.taxId, accession: best.accession, entrez, rid: res.rid, detail: `${best.organism} ${best.accession} (${best.identityPct}% identity, ${best.coveragePct}% coverage)` });
    }
    if (!members.length) throw new Fatal(`None of the names produced a usable sequence. ${notes.map((n) => `${n.name}: ${n.detail}`).join(' ')}`);
    const base = prev?.dataset.members ?? [queryMember(recordId)];
    const dsId = saveDataset(recordId, j.userId, `Dataset: added ${members.length} species by name`, { names, role: params.role }, [queryMember(recordId), ...base.filter((m) => m.role !== 'query'), ...members], { automatic: false, jobId: j.id, tool: 'VierStation', extra: { excluded: (prev?.op.result as { excluded?: unknown })?.excluded ?? [], source: 'species_names', speciesNotes: notes }, basis: {}, dbSource: 'NCBI Taxonomy, NCBI Nucleotide', dbRetrievedAt: now() });
    for (const n of notes) if (n.status !== 'added') warnings.push(`${n.name}: ${n.detail}`);
    return { result: { added: members.length, notes, dataset: dsId }, warnings, outputRef: dsId, value: { added: members.length, _notify: { kind: 'analysis_completed' as const, title: `Added ${members.length} species by name`, link: `/lab/${recordId}?section=relatives` } } };
  });
}, { maxAttempts: 2 });

// ---------------------------------------------------------------- outgroups
export interface OutgroupParams { max: number; minCoverage: number; excludeTaxId?: number; withinTaxId?: number; hitlist: number }
export const DEFAULT_OUTGROUP: OutgroupParams = { max: 5, minCoverage: 60, hitlist: 100 };

/**
 * Which clade is the ingroup, and which wider clade should outgroups come from? Uses real NCBI lineage ranks.
 * The ingroup clade is the lowest rank (genus → phylum) of the BEST match's lineage that at least 60% of the ingroup shares; relatives outside it are reported.
 * Outgroups are searched in the next higher rank of the best match's lineage, excluding the ingroup clade.
 */
export interface Scope { taxId: number; name: string; rank: string }
export function chooseScopes(ingroup: Member[]): { ingroup: Scope; outside: Scope; ladder: Scope[]; outliers: number } | null {
  const withLin = ingroup.filter((m) => m.lineage.length);
  if (!withLin.length) return null;
  const best = withLin.slice().sort((a, b) => (b.bitScore ?? 0) - (a.bitScore ?? 0))[0];
  const ranks = ['genus', 'family', 'order', 'class', 'phylum', 'kingdom'];
  for (let i = 0; i < ranks.length - 1; i++) {
    const inNode = best.lineage.find((n) => n.rank === ranks[i]); if (!inNode) continue;
    const share = withLin.filter((m) => m.lineage.some((l) => l.taxId === inNode.taxId)).length / withLin.length;
    if (share < 0.6) continue;
    const ladder: Scope[] = ranks.slice(i + 1).map((r) => best.lineage.find((n) => n.rank === r)).filter((n): n is NonNullable<typeof n> => !!n).map((n) => ({ taxId: n.taxId, name: n.name, rank: n.rank }));
    if (!ladder.length) return null;
    return { ingroup: { taxId: inNode.taxId, name: inNode.name, rank: inNode.rank }, outside: ladder[0], ladder, outliers: withLin.filter((m) => !m.lineage.some((l) => l.taxId === inNode.taxId)).length };
  }
  return null;
}

registerJob('seq.outgroups', async (j) => {
  const { recordId } = j.payload as { recordId: string };
  const params: OutgroupParams = { ...DEFAULT_OUTGROUP, ...(j.payload.params ?? {}) };
  const ds = currentDataset(recordId);
  const ingroup = ds?.dataset.members.filter((m) => m.role === 'ingroup') ?? [];
  if (!ingroup.length) throw new Fatal('Build the related-species dataset first – outgroups are chosen relative to the ingroup.');
  const scopes = params.excludeTaxId && params.withinTaxId ? null : chooseScopes(ingroup);
  const inTax = params.excludeTaxId ?? scopes?.ingroup.taxId, outTax = params.withinTaxId ?? scopes?.outside.taxId;
  if (!inTax || !outTax) throw new Fatal('The ingroup\'s taxonomy is too incomplete to define a sister clade automatically. Add outgroups manually by accession.');
  const ladder: Scope[] = scopes?.ladder ?? [{ taxId: outTax, name: `taxon ${outTax}`, rank: 'taxon' }];
  const qLen = stateOf(recordId)!.head.seq.length;
  // every genus that already has an ingroup member is excluded from the search itself (so its many near-identical records cannot fill the hit list)
  const genusIds = [...new Set(ingroup.flatMap((m) => m.lineage.filter((l) => l.rank === 'genus').map((l) => l.taxId)))].filter((g) => g !== inTax).slice(0, 8);
  const ingroupGenera = new Set(ingroup.map((m) => rankName(m, 'genus') ?? genusOf(m.organism)));
  // a true outgroup must be clearly MORE divergent from the query than the least similar ingroup member; a record that is just as similar is an ingroup member or a mislabeled submission
  const ingroupMinId = Math.min(...ingroup.map((m) => m.identityPct ?? 100)), maxOutId = ingroupMinId - 0.5;
  return asOp(j, recordId, { step: 'outgroups', name: 'Outgroup selection assistant', inputRef: ds!.op.id, params: { ...params, ingroupScope: scopes?.ingroup, outsideScope: scopes?.outside }, tool: 'NCBI BLAST (taxon-restricted) + NCBI Taxonomy', dbSource: 'NCBI BLAST core_nt, NCBI Taxonomy' }, async () => {
    const candidates: Member[] = [], excluded: { accession: string; organism: string; reason: string }[] = [];
    const rounds: { scope: Scope; entrez: string; rid: string; hits: number; found: number }[] = [];
    const perGenus = new Set<string>(), perFamily = new Map<string, number>(), seenAcc = new Set<string>();
    const wanted = Math.min(3, params.max); // widen the sister clade while fewer than this many candidates exist
    for (const scope of ladder.slice(0, 2)) {
      guard(j);
      const entrez = `txid${scope.taxId}[Organism:exp] NOT txid${inTax}[Organism:exp]${genusIds.map((g) => ` NOT txid${g}[Organism:exp]`).join('')}`;
      j.progress(0, null, `Searching ${scope.name} (${scope.rank}) outside the ingroup`);
      const res = await blastRun(stateOf(recordId)!.head.seq.replace(/-/g, ''), { db: 'core_nt', program: 'blastn', megablast: false, hitlist: params.hitlist, expect: 1, entrez, signal: j.signal, onWait: (m) => { j.log(m); j.progress(0, null, m); } });
      guard(j);
      const hits = res.hits.map((h) => normaliseHit(h, qLen, false)).sort((a, b) => b.bitScore - a.bitScore);
      const usable = hits.filter((h) => { const why = h.environmental ? 'uncultured / environmental / synthetic / unresolved name (no species epithet)' : h.coveragePct < params.minCoverage ? `query coverage ${h.coveragePct}% < ${params.minCoverage}%` : h.identityPct > maxOutId ? `${h.identityPct}% identity is as high as the ingroup's (least similar ingroup member: ${ingroupMinId}%) – such records are usually ingroup members or mislabeled GenBank entries, not true outgroups` : seenAcc.has(h.accession) ? 'already considered in the previous search' : null; if (why) excluded.push({ accession: h.accession, organism: h.organism, reason: why }); return !why; });
      const lin = await lineagesFor(usable.slice(0, 40).map((h) => h.taxId), j.signal);
      // one per genus, at most 2 per family: sister lineages that are close but outside the ingroup, spread over several genera
      const picked: LabHit[] = [];
      for (const h of usable.slice(0, 40)) {
        seenAcc.add(h.accession);
        const l = lin.get(h.taxId ?? -1)?.lineage ?? [], g = rankName({ lineage: l }, 'genus') ?? genusOf(h.organism), f = rankName({ lineage: l }, 'family') ?? '?';
        const why = ingroupGenera.has(g) ? 'belongs to a genus already in the ingroup' : perGenus.has(g) ? `genus ${g} already represented` : (perFamily.get(f) ?? 0) >= 2 ? `family ${f} already has 2 candidates` : null;
        if (why) { excluded.push({ accession: h.accession, organism: h.organism, reason: why }); continue; }
        perGenus.add(g); perFamily.set(f, (perFamily.get(f) ?? 0) + 1); picked.push(h);
        if (candidates.length + picked.length >= params.max) break;
      }
      let done = 0, found = 0;
      for (const h of picked) {
        guard(j); j.progress(done++, picked.length, `Retrieving region of ${h.accession}`);
        let reg: RegionFetch | null = null;
        try { reg = await fetchHitRegion(h, qLen, j.signal); } catch (e) { if (e instanceof Cancelled) throw e; j.log(`Could not retrieve ${h.accession}`, 'warn'); }
        if (!reg) { excluded.push({ accession: h.accession, organism: h.organism, reason: 'region could not be retrieved' }); continue; }
        const hl = lin.get(h.taxId ?? -1);
        candidates.push(asMember(h, reg, 'outgroup', [
          `Outside the ingroup clade ${scopes ? `${scopes.ingroup.name} (${scopes.ingroup.rank})` : `txid ${inTax}`} but inside ${scope.name} (${scope.rank})`,
          `Alignable marker region: ${h.identityPct}% identity over ${h.coveragePct}% of the query`,
          `Close enough to align reliably, distant enough not to fall inside the ingroup – sister lineages place the root with the least long-branch distortion`,
        ], hl, 'taxon_blast')); found++;
      }
      rounds.push({ scope, entrez, rid: res.rid, hits: hits.length, found });
      if (candidates.length >= wanted) break;
    }
    const warnings: string[] = [];
    if (rounds.length > 1) warnings.push(`Fewer than ${wanted} candidates were found in ${rounds[0].scope.name} (${rounds[0].scope.rank}), so the search was widened to ${rounds[1].scope.name} (${rounds[1].scope.rank}). More distant outgroups align less reliably and can distort the tree.`);
    if (scopes?.outliers) warnings.push(`${scopes.outliers} of the ingroup sequence(s) lie outside ${scopes.ingroup.name}; the outgroup search treats ${scopes.ingroup.name} as the ingroup clade.`);
    if (candidates.length < params.max) warnings.push(candidates.length ? `Only ${candidates.length} suitable outgroup candidate(s) were found (requested up to ${params.max}). Reasons for exclusions are listed below; broaden the sister clade or add an outgroup manually if you need more.` : 'No suitable outgroup was found in the sister lineage. The tree can still be built unrooted or midpoint-rooted, but then the root is an assumption.');
    return { result: { scopes, entrez: rounds[0]?.entrez, rounds, candidates, excluded, searched: rounds.reduce((a, r) => a + r.hits, 0), rid: rounds[0]?.rid, retrievedAt: now() }, warnings, value: { candidates: candidates.length, _notify: { kind: 'analysis_completed' as const, title: `${candidates.length} outgroup candidate(s) found`, link: `/lab/${recordId}?section=outgroups` } } };
  });
}, { maxAttempts: 2 });

// ---------------------------------------------------------------- alignment
registerJob('seq.align', async (j) => {
  const { recordId } = j.payload as { recordId: string };
  const options: MsaOptions = { ...defaultMsa('dna'), ...(j.payload.params ?? {}) };
  const ds = currentDataset(recordId);
  if (!ds || ds.dataset.members.length < 2) throw new Fatal('The alignment needs at least two sequences. Build the related-species dataset first, or add sequences manually.');
  const members = [queryMember(recordId), ...ds.dataset.members.filter((m) => m.role !== 'query')];
  const engine: string = j.payload.params?.engine ?? 'builtin';
  const ext = engine === 'builtin' ? null : (await detectAligners()).find((a) => a.id === engine);
  return asOp(j, recordId, { step: 'align', name: ext ? `Multiple alignment (${ext.name})` : engine === 'builtin' ? `Multiple alignment (${options.method})` : `Multiple alignment (${engine})`, inputRef: ds.op.id, params: { ...options, engine }, tool: ext ? `${ext.name} (external program)` : 'VierStation built-in MSA', toolVersion: ext ? ext.version : '1' }, async () => {
    if (engine !== 'builtin' && !ext) throw new Fatal(`${engine} is not installed on the server (or not on its PATH). Choose the built-in aligner or install it.`);
    j.progress(0, null, ext ? `Running ${ext.name}` : 'Aligning');
    let r: MsaRun;
    if (ext) {
      const x = await runExternal(ext, members.map((m) => m.seq), { signal: j.signal });
      const sum = columnSummary(x.rows);
      r = { labels: members.map((m) => m.label), rows: x.rows, length: sum.length, conservation: sum.conservation, consensus: sum.consensus, method: `${ext.name} ${ext.version} (external)`, spScore: spScore(x.rows, options), guideTree: '', iterations: [], options, warnings: [`The sum-of-pairs score is computed by VierStation's scoring scheme for comparison; ${ext.name} used its own scoring.`], command: x.command } as MsaRun & { command: string };
    } else r = await runTask<MsaRun>('msa', { labels: members.map((m) => m.label), seqs: members.map((m) => m.seq), options }, { signal: j.signal, onProgress: (d, t, m) => j.progress(d, t, m) });
    const roles = Object.fromEntries(members.map((m) => [m.label, m.role]));
    return { result: { ...r, roles, manualEdits: 0, datasetOp: ds.op.id }, warnings: r.warnings, value: { rows: r.rows.length, length: r.length, spScore: r.spScore, _notify: { kind: 'analysis_completed' as const, title: `Alignment done: ${r.rows.length} sequences × ${r.length} columns`, link: `/lab/${recordId}?section=alignment` } } };
  });
}, { maxAttempts: 1 });

// ---------------------------------------------------------------- tree
registerJob('seq.tree', async (j) => {
  const { recordId } = j.payload as { recordId: string };
  const alignOp = j.payload.alignOpId ? getOp(j.payload.alignOpId) : latestOp(recordId, 'align_edit') ?? latestOp(recordId, 'align');
  const latestAlign = latestOp(recordId, 'align'), latestEdit = latestOp(recordId, 'align_edit');
  const src = j.payload.alignOpId ? alignOp : (latestEdit && latestAlign && latestEdit.createdAt >= latestAlign.createdAt ? latestEdit : latestAlign);
  if (!src?.result?.rows) throw new Fatal('Align the sequences first – a tree is built from an alignment.');
  const params: PhyloParams = { ...DEFAULT_PARAMS, ...(j.payload.params ?? {}) };
  const roles: Record<string, string> = src.result.roles ?? {};
  if (params.rooting === 'outgroup' && !params.outgroups.length) params.outgroups = Object.entries(roles).filter(([, r]) => r === 'outgroup').map(([l]) => l);
  const ds = currentDataset(recordId)?.dataset;
  return asOp(j, recordId, { step: 'tree', name: `Phylogenetic tree (${params.method.toUpperCase()})`, inputRef: src.id, params, tool: 'VierStation built-in phylogenetics', toolVersion: '1' }, async () => {
    const res = await runTask<PhyloResult>('phylo', { labels: src.result.labels, rows: src.result.rows, params }, { signal: j.signal, onProgress: (d, t, m) => j.progress(d, t, m) });
    const members: Member[] = (ds?.members ?? []).map((m) => ({ ...m, seq: '' }));
    const interpretation = interpretTree(res, members.length ? members : (Object.keys(roles).map((l) => ({ label: l, role: roles[l], organism: l, accession: null, taxId: null, lineage: [] })) as unknown as Member[]));
    return { result: { ...res, roles, interpretation, alignOp: src.id }, warnings: res.warnings, value: { newick: res.newick.length, support: Object.keys(res.support).length, _notify: { kind: 'analysis_completed' as const, title: 'Tree finished', body: interpretation.summary, link: `/lab/${recordId}?section=tree` } } };
  });
}, { maxAttempts: 1 });

