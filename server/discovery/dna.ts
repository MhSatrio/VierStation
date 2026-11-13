// DNA -> Gene discovery (FR-1.7). Never assumes a sequence encodes a protein: sequences are classified as
// coding / non-coding / partial / uncertain, and the basis (annotation vs. inference) is recorded on every link.
import { Fatal } from '../jobs.ts';
import type { Ctx } from '../ingest.ts';
import { byKeys, fillRecord, linkByTables, tableOfKind, upsertByKey, valueOf, setStatus, addProvenance } from '../ingest.ts';
import { cdsFrom, collectionInfo, fetchGenBank, genesFrom, geneIdsForNucleotide, nucSummary, sourceUrl, blastRun, geneSummary, fetchFasta, taxonomyName } from '../integrations/ncbi.ts';
import type { GenBank, GbCds, GbGene, NucSummary, BlastHit } from '../integrations/ncbi.ts';
import { cleanSeq, detectSeqKind, findOrfs, parseFasta, RE, stripVersion } from '../../shared/sequence.ts';
import type { Orf } from '../../shared/sequence.ts';
import { fieldByKey } from '../schema.ts';
import { getRaw } from '../records.ts';
import { importGeneById } from './protein.ts';
import { now } from '../util.ts';
import { config } from '../config.ts';

export type SeqClass = 'Coding DNA' | 'Non-coding DNA' | 'Partial sequence' | 'Uncertain annotation' | 'mRNA / cDNA' | 'Genomic';
export interface Classification { cls: SeqClass; basis: 'annotated' | 'inferred' | 'none'; note: string }

const NONCODING_FEATURES = new Set(['ncRNA', 'rRNA', 'tRNA', 'misc_RNA', 'tmRNA', 'regulatory', 'repeat_region']);

/** Pure classification so it can be unit-tested on fixtures (see tests/discovery.test.ts). */
export function classifyNucleotide(a: { moltype?: string; biomol?: string; completeness?: string; length: number; genes: GbGene[]; cds: GbCds[]; featureTypes: string[]; sequence: string }): Classification {
  const isRna = /rna/i.test(a.moltype ?? '') || /mrna|cdna/i.test(a.biomol ?? '');
  const partialMeta = /partial/i.test(a.completeness ?? '');
  if (a.cds.length) {
    const allPartial = a.cds.every((c) => c.partial);
    if (allPartial || (partialMeta && a.cds.some((c) => c.partial))) return { cls: 'Partial sequence', basis: 'annotated', note: 'GenBank annotates a partial CDS (5\' and/or 3\' end missing).' };
    if (a.length > 50_000 || a.genes.length >= 3) return { cls: 'Genomic', basis: 'annotated', note: `Genomic region with ${a.genes.length} annotated gene(s).` };
    if (isRna) return { cls: 'mRNA / cDNA', basis: 'annotated', note: `Transcript with ${a.cds.length} annotated CDS.` };
    return { cls: 'Coding DNA', basis: 'annotated', note: `${a.cds.length} annotated CDS feature(s).` };
  }
  if (a.featureTypes.some((t) => NONCODING_FEATURES.has(t)) && !a.cds.length) return { cls: 'Non-coding DNA', basis: 'annotated', note: `Annotated as ${a.featureTypes.filter((t) => NONCODING_FEATURES.has(t)).join(', ')}; no CDS feature.` };
  if (a.length > 50_000) return { cls: 'Genomic', basis: 'annotated', note: 'Large genomic record without CDS features in this region.' };
  // No annotation at all: fall back to ORF analysis and label it as inference, not fact.
  const seq = cleanSeq(a.sequence);
  if (seq.length < 90) return { cls: 'Uncertain annotation', basis: 'none', note: 'Too short (<90 nt) to infer coding potential.' };
  const orfs = findOrfs(seq, 60);
  const complete = orfs.find((o) => o.startsWithMet && o.endsWithStop); // a complete ORF is the strongest sign of a coding sequence
  if (complete) {
    const cover = (complete.end - complete.start) / seq.length;
    if (complete.aaLength >= 100 && cover >= 0.5) return { cls: 'Coding DNA', basis: 'inferred', note: `Inferred from a ${complete.aaLength}-aa ORF on the ${complete.strand} strand covering ${Math.round(cover * 100)}% of the sequence (not an annotation).` };
  }
  const best = orfs[0];
  if (best && best.aaLength >= 100 && (best.end - best.start) / seq.length >= 0.5) return { cls: 'Partial sequence', basis: 'inferred', note: `Long ORF (${best.aaLength} aa) lacking ${!best.startsWithMet ? 'a start codon' : 'a stop codon'}: probably a partial coding sequence (inferred).` };
  return { cls: 'Uncertain annotation', basis: 'none', note: 'No annotation and no dominant open reading frame; coding potential cannot be established.' };
}

export interface NucImport { recordId: string; tableId: string; accession: string; summary: NucSummary | null; gb: GenBank | null; classification: Classification; warnings: string[] }

const MAX_FETCH_BP = 2_000_000;

/** Fetch an NCBI nucleotide record and write it (and its organism) to the DNA table. Fills an existing record when recordId is given. */
export async function importNucleotide(c: Ctx, accession: string, o: { recordId?: string; query?: string } = {}): Promise<NucImport> {
  const acc = accession.trim();
  const sum = await nucSummary(acc, c.signal);
  if (!sum) throw new Fatal(`Accession "${acc}" was not found in NCBI Nucleotide. Check the identifier (RefSeq NM_/NC_/NR_ or GenBank).`);
  if (sum.length > MAX_FETCH_BP) throw new Fatal(`${sum.accession} is ${sum.length.toLocaleString()} bp – too large to import whole. Enter genomic coordinates instead (e.g. ${sum.accession}:1000-20000).`);
  c.log(`Found ${sum.accession}: ${sum.title}`);
  const gb = await fetchGenBank(sum.accession, { signal: c.signal });
  if (!gb) throw new Fatal(`NCBI returned no GenBank record for ${sum.accession}`);
  const cds = cdsFrom(gb), genes = genesFrom(gb);
  const cls = classifyNucleotide({ moltype: sum.moltype, biomol: sum.biomol, completeness: sum.completeness, length: gb.length, genes, cds, featureTypes: [...new Set(gb.features.map((f) => f.type))], sequence: gb.sequence });
  const tableId = tableOfKind(c, 'dna');
  const values = {
    name: sum.title, accession: sum.accession, sequence: gb.sequence, length: gb.sequence.length || gb.length, seqClass: cls.cls, source: 'NCBI Nucleotide',
    collection: collectionInfo(gb), retrieved: now(),
  };
  const prov = { sourceDb: 'NCBI Nucleotide', accession: sum.accession, query: o.query ?? acc, url: sourceUrl.nuccore(sum.accession), step: 'import', note: `${cls.cls} (${cls.basis}): ${cls.note}` };
  let recordId: string;
  if (o.recordId) { fillRecord(c, tableId, o.recordId, values, prov, ['name', 'accession']); recordId = o.recordId; }
  else recordId = upsertByKey(c, tableId, 'accession', sum.accession, values, prov, { alsoMatch: [['accession', stripVersion(sum.accession)]] }).id;
  await attachOrganism(c, tableId, recordId, sum.taxId ?? gb.taxId, sum.organism || gb.organism, 'NCBI Nucleotide', sourceUrl.nuccore(sum.accession));
  setStatus(tableId, recordId, cls.basis === 'none' ? 'Review' : 'Completed', c);
  return { recordId, tableId, accession: sum.accession, summary: sum, gb, classification: cls, warnings: [] };
}

/** Find-or-create the Organism record and link it from `recordId` if the table has an Organism relation. */
export async function attachOrganism(c: Ctx, fromTable: string, recordId: string, taxId: number | string | null, name: string, sourceDb: string, url: string) {
  if (!taxId && !name) return;
  const orgTable = tableOfKind(c, 'organism');
  const t = taxId ? String(taxId) : '';
  const sci = name || (taxId ? (await taxonomyName(taxId, c.signal))?.scientificName ?? '' : '');
  const org = upsertByKey(c, orgTable, t ? 'taxid' : 'name', t || sci, { name: sci, taxid: t || undefined }, { sourceDb, accession: t || null, url: t ? sourceUrl.taxonomy(t) : url, step: 'import' });
  linkByTables(fromTable, recordId, orgTable, org.id, { evidenceClass: 'database_annotated', evidence: `Source organism recorded by ${sourceDb}`, sourceDb, relationType: 'from organism', referenceUrl: url });
}

export interface GeneLink { geneRecordId: string; geneId: string; symbol: string; basis: string; evidenceClass: 'database_annotated' | 'sequence_inferred' }
export interface GeneDiscovery { genes: GeneLink[]; classification: Classification; notes: string[]; blast?: { db: string; hit: string; identity: number; coverage: number }[] }

function genomicRegion(input: string): { acc: string; from: number; to: number } | null {
  const m = RE.coords.exec(input.trim());
  if (!m) return null;
  const [, acc, a, b] = m;
  const from = Number(a.replace(/,/g, '')), to = Number(b.replace(/,/g, ''));
  if (!/^(?:N[CGTWZ]|AC|CM)_?/i.test(acc) && !/^[A-Z]{1,2}\d+(\.\d+)?$/.test(acc)) return null;
  return { acc, from: Math.min(from, to), to: Math.max(from, to) };
}

/** Import a genomic region given as "NC_000017.11:7668402-7687550" into a DNA record (sequence + annotated genes). */
export async function importRegion(c: Ctx, input: string, o: { recordId?: string } = {}): Promise<NucImport> {
  const reg = genomicRegion(input);
  if (!reg) throw new Fatal('Coordinates must look like NC_000017.11:7668402-7687550');
  if (reg.to - reg.from > 1_000_000) throw new Fatal('Regions larger than 1 Mb are not supported. Choose a smaller region.');
  const gb = await fetchGenBank(reg.acc, { from: reg.from, to: reg.to, signal: c.signal });
  if (!gb) throw new Fatal(`NCBI returned nothing for ${input}`);
  const cds = cdsFrom(gb), genes = genesFrom(gb);
  const cls = classifyNucleotide({ moltype: 'dna', length: reg.to - reg.from + 1, genes, cds, featureTypes: [...new Set(gb.features.map((f) => f.type))], sequence: gb.sequence });
  const tableId = tableOfKind(c, 'dna');
  const label = `${reg.acc}:${reg.from}-${reg.to}`;
  const values = { name: `${gb.definition || reg.acc} [${reg.from}-${reg.to}]`, accession: label, sequence: gb.sequence, length: gb.sequence.length, seqClass: cls.cls, source: 'NCBI Nucleotide (region)', collection: collectionInfo(gb), retrieved: now() };
  const prov = { sourceDb: 'NCBI Nucleotide', accession: label, query: input, url: sourceUrl.nuccore(reg.acc), step: 'import', note: `Region ${reg.from}-${reg.to}; ${cls.cls}: ${cls.note}` };
  const recordId = o.recordId ? (fillRecord(c, tableId, o.recordId, values, prov, ['sequence', 'length']), o.recordId) : upsertByKey(c, tableId, 'accession', label, values, prov).id;
  await attachOrganism(c, tableId, recordId, gb.taxId, gb.organism, 'NCBI Nucleotide', sourceUrl.nuccore(reg.acc));
  setStatus(tableId, recordId, 'Completed', c);
  return { recordId, tableId, accession: label, summary: null, gb, classification: cls, warnings: [] };
}

/** Parse FASTA / raw pasted sequences into DNA records. Returns the record ids created (or matched). */
export function importFasta(c: Ctx, text: string): { recordId: string; id: string; length: number; created: boolean }[] {
  const recs = parseFasta(text);
  if (!recs.length) throw new Fatal('No sequences found. Paste FASTA text or a plain nucleotide sequence.');
  const tableId = tableOfKind(c, 'dna');
  const out = [];
  for (const r of recs.slice(0, 500)) {
    const kind = detectSeqKind(r.seq);
    if (kind === 'protein') throw new Fatal(`"${r.id}" looks like a protein sequence. Import it into Proteins instead.`);
    if (kind === 'unknown') throw new Fatal(`"${r.id}" contains characters that are not valid nucleotide codes.`);
    const dna = r.seq.replace(/U/g, 'T');
    const cls = classifyNucleotide({ length: dna.length, genes: [], cds: [], featureTypes: [], sequence: dna });
    const res = upsertByKey(c, tableId, 'name', r.id, { sequence: dna, length: dna.length, seqClass: cls.cls, source: 'User FASTA', retrieved: now(), accession: RE.refseqNuc.test(r.id) || RE.genbankNuc.test(r.id) ? r.id : undefined },
      { sourceDb: 'User upload (FASTA)', accession: r.id, query: r.header, step: 'import', note: `${cls.cls} (${cls.basis}): ${cls.note}` });
    setStatus(tableId, res.id, 'To fetch', c);
    out.push({ recordId: res.id, id: r.id, length: dna.length, created: res.created });
  }
  return out;
}

/** Identify annotated genes for a DNA record, via GenBank annotation first and BLAST similarity second. */
export async function discoverGenes(c: Ctx, dnaRecordId: string, o: { allowBlast?: boolean; progress?: (m: string) => void } = {}): Promise<GeneDiscovery> {
  const tableId = getRaw(dnaRecordId)?.tableId;
  if (!tableId) throw new Fatal('DNA record not found');
  const geneTable = tableOfKind(c, 'gene');
  const accession = String(valueOf(tableId, dnaRecordId, 'accession') ?? '').trim();
  const seqRaw = String(valueOf(tableId, dnaRecordId, 'sequence') ?? '');
  const notes: string[] = [];
  const found: GeneLink[] = [];
  let classification: Classification = { cls: 'Uncertain annotation', basis: 'none', note: '' };

  const linkGene = async (geneId: string, evidenceClass: GeneLink['evidenceClass'], ev: string, sourceDb: string, url: string, rel: string, details?: Record<string, unknown>) => {
    const g = await importGeneById(c, geneId, { fromQuery: accession || `sequence ${dnaRecordId}` });
    if (!g) { notes.push(`Gene ${geneId} could not be retrieved from NCBI Gene`); return; }
    linkByTables(tableId, dnaRecordId, geneTable, g.recordId, { relationType: rel, evidenceClass, evidence: ev, sourceDb, referenceUrl: url, sourceId: geneId, details });
    if (!found.some((f) => f.geneRecordId === g.recordId)) found.push({ geneRecordId: g.recordId, geneId, symbol: g.symbol, basis: ev, evidenceClass });
  };

  // 1) annotation on the record itself (accession / region)
  let gb: GenBank | null = null, nuc: NucSummary | null = null;
  const region = genomicRegion(accession);
  if (accession && !region) {
    nuc = await nucSummary(accession, c.signal);
    if (nuc && nuc.length <= MAX_FETCH_BP) gb = await fetchGenBank(nuc.accession, { signal: c.signal });
  } else if (region && region.to - region.from <= 1_000_000) {
    gb = await fetchGenBank(region.acc, { from: region.from, to: region.to, signal: c.signal });
  }
  if (gb) {
    const cds = cdsFrom(gb), genes = genesFrom(gb);
    classification = classifyNucleotide({ moltype: nuc?.moltype, biomol: nuc?.biomol, completeness: nuc?.completeness, length: gb.length, genes, cds, featureTypes: [...new Set(gb.features.map((f) => f.type))], sequence: gb.sequence });
    const cdsGenes = new Set(cds.map((x) => x.geneId).filter(Boolean));
    // regional pulls from a chromosome list every overlapping gene; cap to keep the graph readable
    for (const g of genes.slice(0, 25)) {
      if (!g.geneId) { notes.push(`Gene "${g.symbol}" in the annotation has no NCBI GeneID; skipped`); continue; }
      const encodes = cdsGenes.has(g.geneId);
      await linkGene(g.geneId, 'database_annotated', `${encodes ? 'GenBank annotates a CDS' : 'GenBank annotates a gene feature'} for ${g.symbol} at ${g.location}${g.partial ? ' (partial)' : ''}`,
        'NCBI GenBank', sourceUrl.gene(g.geneId), encodes ? 'encodes' : 'overlaps gene', { location: g.location, accession: gb.accession, partial: g.partial, pseudogene: g.pseudo });
    }
    if (!found.length && nuc) {
      for (const gid of (await geneIdsForNucleotide(nuc.uid, c.signal)).slice(0, 10)) await linkGene(gid, 'database_annotated', 'NCBI links this nucleotide record to the gene (Entrez link nuccore_gene)', 'NCBI Entrez', sourceUrl.gene(gid), 'linked gene');
    }
    if (found.length) return { genes: found, classification, notes };
    notes.push('The record has no annotated gene features.');
  }

  // 2) sequence similarity (BLAST) – only for sequences that are present locally
  const seq = cleanSeq(seqRaw).replace(/U/g, 'T');
  if (!seq) { notes.push(accession ? 'No sequence stored and the accession carries no gene annotation.' : 'Record has neither an accession nor a sequence.'); return { genes: found, classification, notes }; }
  const kind = detectSeqKind(seq);
  if (kind === 'protein') throw new Fatal('This looks like a protein sequence; DNA-to-gene discovery needs nucleotides.');
  if (!gb) classification = classifyNucleotide({ length: seq.length, genes: [], cds: [], featureTypes: [], sequence: seq });
  if (o.allowBlast === false || config.offline) { notes.push('Similarity search skipped.'); return { genes: found, classification, notes }; }
  if (seq.length < 25) { notes.push('Sequence is too short (<25 nt) for a reliable similarity search.'); return { genes: found, classification, notes }; }
  if (seq.length > 100_000) { notes.push('Sequence is longer than 100 kb; BLAST discovery is limited to shorter sequences. Provide an accession or coordinates.'); return { genes: found, classification, notes }; }

  const blastLog: GeneDiscovery['blast'] = [];
  const attempts: { db: string; entrez?: string }[] = [{ db: 'refseq_rna' }, { db: 'core_nt', entrez: 'srcdb_refseq[prop]' }];
  for (const a of attempts) {
    c.log(`BLAST (megablast) against ${a.db} …`);
    const res = await blastRun(seq, { ...a, hitlist: 8, signal: c.signal, onWait: (m) => { c.log(m); o.progress?.(m); } });
    const good = res.hits.filter((h) => h.bestIdentityPct >= 90 && h.queryCoveragePct >= 70);
    for (const h of res.hits.slice(0, 3)) blastLog.push({ db: a.db, hit: `${h.accession} ${h.title}`, identity: h.bestIdentityPct, coverage: h.queryCoveragePct });
    if (!good.length) { notes.push(`No confident similarity hit in ${a.db} (need ≥90% identity over ≥70% of the query).`); continue; }
    const top = good[0];
    notes.push(`Best match ${top.accession} (${top.bestIdentityPct}% identity, ${top.queryCoveragePct}% of query) in ${a.db}.`);
    await genesFromHit(top, a.db, res.rid);
    if (found.length) break;
  }
  async function genesFromHit(h: BlastHit, db: string, rid: string) {
    const hsp = h.hsps[0];
    const region = h.length > 1_000_000 && hsp ? { from: Math.max(1, Math.min(hsp.hitFrom, hsp.hitTo) - 1), to: Math.max(hsp.hitFrom, hsp.hitTo) + 1 } : undefined;
    const hgb = await fetchGenBank(h.accession, { ...region, signal: c.signal });
    if (!hgb) return;
    const hcds = new Set(cdsFrom(hgb).map((x) => x.geneId).filter(Boolean));
    for (const g of genesFrom(hgb).slice(0, 10)) {
      if (!g.geneId) continue;
      await linkGene(g.geneId, 'sequence_inferred', `Sequence matches ${h.accession} (${h.bestIdentityPct}% identity over ${h.queryCoveragePct}% of the query, E=${hsp?.evalue}), which is annotated as gene ${g.symbol}`,
        'NCBI BLAST', `https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Get&RID=${rid}`, hcds.has(g.geneId) ? 'matches transcript of' : 'matches region of gene',
        { blastDb: db, hit: h.accession, identityPct: h.bestIdentityPct, queryCoveragePct: h.queryCoveragePct, evalue: hsp?.evalue, rid });
    }
  }
  if (found.length) {
    // the user's sequence is similar to an annotated record, not itself annotated: say so
    classification = { ...classification, note: `${classification.note} Gene assignment is inferred from sequence similarity, not from an annotation on this record.`.trim() };
  } else {
    const orfs: Orf[] = findOrfs(seq, 60);
    if (orfs[0]) notes.push(`Longest open reading frame: ${orfs[0].aaLength} aa on the ${orfs[0].strand} strand (${orfs[0].startsWithMet ? 'starts with Met' : 'no start codon'}, ${orfs[0].endsWithStop ? 'stop present' : 'no stop'}). This is a computational prediction only.`);
    notes.push('No gene could be assigned. The record is marked for review rather than guessed.');
  }
  return { genes: found, classification, notes, blast: blastLog };
}

/** Convenience used by pasted-sequence flows: apply a classification result back onto the DNA record. */
export function applyClassification(c: Ctx, dnaRecordId: string, cl: Classification, source: string) {
  const tableId = getRaw(dnaRecordId)!.tableId;
  if (!fieldByKey(tableId, 'seqClass')) return;
  fillRecord(c, tableId, dnaRecordId, { seqClass: cl.cls }, { sourceDb: source, step: 'classification', note: `${cl.cls} (${cl.basis}): ${cl.note}` }, ['seqClass']);
}

export { addProvenance, byKeys, geneSummary, fetchFasta };
