// Gene -> Protein discovery (FR-1.8): UniProt cross-references first, RefSeq/CDS translation as fallback; isoforms preserved.
import { Fatal } from '../jobs.ts';
import type { Ctx } from '../ingest.ts';
import { addProvenance, fillRecord, linkByTables, tableOfKind, upsertByKey, valueOf } from '../ingest.ts';
import { geneSummary, refseqProteinsForGene, sourceUrl, fetchFasta, entrezSearch } from '../integrations/ncbi.ts';
import { isoformSequence, uniprotByGeneId, uniprotByGene, uniprotEntry, uniprotUrl } from '../integrations/uniprot.ts';
import type { UniProtEntry } from '../integrations/uniprot.ts';
import { interproForProtein, interproUrl } from '../integrations/interpro.ts';
import { getJson } from '../integrations/http.ts';
import { getRaw } from '../records.ts';
import { now } from '../util.ts';
import { parseFasta } from '../../shared/sequence.ts';
import { attachOrganism } from './dna.ts';

// ---------------- genes ----------------
export interface GeneImport { recordId: string; geneId: string; symbol: string; taxId: number | null; organism: string; created: boolean }

export async function importGeneById(c: Ctx, geneId: string, o: { fromQuery?: string; recordId?: string } = {}): Promise<GeneImport | null> {
  const g = await geneSummary(geneId, c.signal);
  if (!g) return null;
  const tableId = tableOfKind(c, 'gene');
  const values = {
    name: g.symbol, geneId: g.geneId, fullName: g.name, geneType: g.type, location: [g.chromosome && `chr ${g.chromosome}`, g.mapLocation].filter(Boolean).join(' '), summary: g.summary,
  };
  const prov = { sourceDb: 'NCBI Gene', accession: g.geneId, query: o.fromQuery ?? geneId, url: sourceUrl.gene(g.geneId), step: 'import', note: g.aliases.length ? `Aliases: ${g.aliases.join(', ')}` : null };
  let id: string, created = false;
  if (o.recordId) { fillRecord(c, tableId, o.recordId, values, prov, ['geneId']); id = o.recordId; }
  else { const r = upsertByKey(c, tableId, 'geneId', g.geneId, values, prov); id = r.id; created = r.created; }
  await attachOrganism(c, tableId, id, g.taxId, g.organism, 'NCBI Gene', sourceUrl.gene(g.geneId));
  return { recordId: id, geneId: g.geneId, symbol: g.symbol, taxId: g.taxId, organism: g.organism, created };
}

// ---------------- publications ----------------
export async function importPublications(c: Ctx, pmids: string[]): Promise<{ recordId: string; pmid: string }[]> {
  const ids = [...new Set(pmids)].slice(0, 12);
  if (!ids.length) return [];
  const sum = await getJson<any>(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${new URLSearchParams({ db: 'pubmed', id: ids.join(','), retmode: 'json', tool: 'VierStation' })}`, { ttl: 7 * 24 * 3600, signal: c.signal });
  const tableId = tableOfKind(c, 'publication');
  const out: { recordId: string; pmid: string }[] = [];
  for (const id of ids) {
    const p = sum?.result?.[id];
    if (!p) continue;
    const doi = (p.articleids ?? []).find((a: any) => a.idtype === 'doi')?.value;
    const year = parseInt(String(p.pubdate ?? '').slice(0, 4), 10);
    const r = upsertByKey(c, tableId, 'pmid', id, { name: p.title ?? `PMID ${id}`, doi, year: Number.isFinite(year) ? year : undefined, journal: p.fulljournalname ?? p.source, url: `https://pubmed.ncbi.nlm.nih.gov/${id}/` },
      { sourceDb: 'PubMed', accession: id, url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`, step: 'import' });
    out.push({ recordId: r.id, pmid: id });
  }
  return out;
}

// ---------------- proteins ----------------
export interface ProteinImport { recordId: string; accession: string; name: string; created: boolean; entry: UniProtEntry | null }

export async function importProteinFromEntry(c: Ctx, e: UniProtEntry, o: { query?: string; recordId?: string; withPublications?: boolean } = {}): Promise<ProteinImport> {
  const tableId = tableOfKind(c, 'protein');
  const values = {
    name: e.name + (e.geneSymbol ? ` (${e.geneSymbol})` : ''), accession: e.accession, sequence: e.sequence, length: e.length, reviewed: e.reviewed, function: e.function,
    isoform: 'canonical', source: 'UniProt', retrieved: now(), structAvail: undefined as string | undefined,
    domains: e.domains.length ? e.domains.map((d) => `${d.description || d.type} ${d.start}-${d.end}`).join('; ') : undefined,
  };
  const prov = { sourceDb: 'UniProt', accession: e.accession, query: o.query ?? e.accession, url: uniprotUrl(e.accession), step: 'import', note: `${e.reviewed ? 'Swiss-Prot (reviewed)' : 'TrEMBL (unreviewed)'}; ${e.existence}` };
  let id: string, created = false;
  if (o.recordId) { fillRecord(c, tableId, o.recordId, values, prov, ['accession', 'sequence', 'length']); id = o.recordId; }
  else { const r = upsertByKey(c, tableId, 'accession', e.accession, values, prov); id = r.id; created = r.created; }
  await attachOrganism(c, tableId, id, e.taxId, e.organism, 'UniProt', uniprotUrl(e.accession));
  if (o.withPublications !== false && e.pubmed.length) {
    const pubTable = tableOfKind(c, 'publication');
    for (const p of await importPublications(c, e.pubmed.slice(0, 8))) {
      linkByTables(tableId, id, pubTable, p.recordId, { relationType: 'cited in UniProt entry', evidenceClass: 'database_annotated', evidence: `PMID ${p.pmid} is cited by UniProt ${e.accession}`, sourceDb: 'UniProt', sourceId: p.pmid, referenceUrl: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/` });
    }
  }
  return { recordId: id, accession: e.accession, name: e.name, created, entry: e };
}

/** Import a protein by UniProt accession (or fill an existing record that has an Accession). */
export async function importProteinByAccession(c: Ctx, accession: string, o: { recordId?: string } = {}): Promise<ProteinImport> {
  const e = await uniprotEntry(accession, c.signal);
  if (!e) throw new Fatal(`UniProt has no entry for "${accession}". Check the accession (e.g. P04637).`);
  return importProteinFromEntry(c, e, { query: accession, recordId: o.recordId });
}

/** InterPro families/domains written to the protein's Domains field with locations. */
export async function enrichDomains(c: Ctx, proteinRecordId: string): Promise<number> {
  const tableId = getRaw(proteinRecordId)!.tableId;
  const acc = String(valueOf(tableId, proteinRecordId, 'accession') ?? '').replace(/-\d+$/, '');
  if (!acc) return 0;
  const entries = await interproForProtein(acc, c.signal);
  if (!entries.length) return 0;
  const text = entries.slice(0, 40).map((e) => `${e.accession} ${e.name} [${e.type}]${e.locations[0] ? ` ${e.locations[0].start}-${e.locations[0].end}` : ''}`).join('\n');
  fillRecord(c, tableId, proteinRecordId, { domains: text }, { sourceDb: 'InterPro', accession: acc, url: interproUrl(entries[0].accession), step: 'domains', note: `${entries.length} InterPro entries` }, ['domains']);
  return entries.length;
}

export interface ProteinDiscovery { proteins: { recordId: string; accession: string; name: string; isoform: string; reviewed: boolean }[]; notes: string[] }

/**
 * Gene -> proteins. A gene may encode several products: UniProt's canonical entry plus each described isoform is stored as
 * its own protein record (accession "P04637-2"), all linked to the gene. Isoform sequences come from UniProt's isoform FASTA.
 */
export async function discoverProteins(c: Ctx, geneRecordId: string, o: { isoforms?: boolean; maxUnreviewed?: number; progress?: (done: number, total: number | null) => void } = {}): Promise<ProteinDiscovery> {
  const geneTable = getRaw(geneRecordId)?.tableId;
  if (!geneTable) throw new Fatal('Gene record not found');
  const protTable = tableOfKind(c, 'protein');
  const geneId = String(valueOf(geneTable, geneRecordId, 'geneId') ?? '').trim();
  const symbol = String(valueOf(geneTable, geneRecordId, 'name') ?? '').trim();
  const notes: string[] = [];
  const out: ProteinDiscovery['proteins'] = [];
  if (!geneId && !symbol) throw new Fatal('The gene needs an NCBI Gene ID or a symbol.');

  let entries: UniProtEntry[] = [];
  if (geneId) entries = await uniprotByGeneId(geneId, c.signal);
  if (!entries.length && symbol) {
    const taxId = (await geneSummary(geneId || '0', c.signal).catch(() => null))?.taxId ?? undefined;
    entries = await uniprotByGene(symbol, taxId, c.signal);
    if (entries.length) notes.push('Matched by gene symbol (no UniProt cross-reference to this Gene ID); evidence is weaker.');
  }
  const reviewed = entries.filter((e) => e.reviewed);
  const unreviewed = entries.filter((e) => !e.reviewed).slice(0, o.maxUnreviewed ?? 3);
  const picks = [...reviewed, ...unreviewed];
  if (entries.length > picks.length) notes.push(`${entries.length - picks.length} additional unreviewed UniProt entries were not imported.`);

  const evidenceClass = geneId && entries.some((e) => e.geneIds.includes(geneId)) ? 'database_annotated' as const : 'sequence_inferred' as const;
  let n = 0;
  for (const e of picks) {
    if (c.signal?.aborted) throw new Error('Cancelled');
    const p = await importProteinFromEntry(c, e, { query: geneId ? `GeneID ${geneId}` : symbol });
    linkByTables(geneTable, geneRecordId, protTable, p.recordId, {
      relationType: 'encodes', evidenceClass, sourceDb: 'UniProt', sourceId: e.accession, referenceUrl: uniprotUrl(e.accession),
      evidence: evidenceClass === 'database_annotated' ? `UniProt ${e.accession} (${e.reviewed ? 'reviewed' : 'unreviewed'}) cross-references NCBI Gene ${geneId}` : `UniProt ${e.accession} matched by gene symbol ${symbol}`,
    });
    out.push({ recordId: p.recordId, accession: e.accession, name: e.name, isoform: 'canonical', reviewed: e.reviewed });
    // isoforms (other than the displayed/canonical one)
    if (o.isoforms !== false && e.reviewed) {
      for (const iso of e.isoforms.filter((i) => i.status !== 'Displayed').slice(0, 12)) {
        const seq = await isoformSequence(iso.id, c.signal);
        if (!seq) { notes.push(`Isoform ${iso.id} sequence unavailable`); continue; }
        const ip = upsertByKey(c, protTable, 'accession', iso.id, {
          name: `${e.name}${e.geneSymbol ? ` (${e.geneSymbol})` : ''} isoform ${iso.name}`, sequence: seq, length: seq.length, reviewed: true, isoform: `isoform ${iso.name}`, source: 'UniProt', retrieved: now(), function: e.function,
        }, { sourceDb: 'UniProt', accession: iso.id, query: e.accession, url: `https://rest.uniprot.org/uniprotkb/${iso.id}.fasta`, step: 'isoform', note: `Isoform ${iso.name} of ${e.accession} (${iso.status})` });
        linkByTables(geneTable, geneRecordId, protTable, ip.id, { relationType: 'encodes (isoform)', evidenceClass, sourceDb: 'UniProt', sourceId: iso.id, referenceUrl: uniprotUrl(e.accession), evidence: `UniProt lists ${iso.id} as an isoform from alternative products of ${e.accession}` });
        out.push({ recordId: ip.id, accession: iso.id, name: `${e.name} isoform ${iso.name}`, isoform: iso.name, reviewed: true });
      }
    }
    o.progress?.(++n, picks.length);
  }

  // Fallback: NCBI RefSeq proteins when UniProt knows nothing about this gene (common for non-model organisms).
  if (!out.length && geneId) {
    const refs = await refseqProteinsForGene(geneId, c.signal);
    for (const r of refs.slice(0, 6)) {
      const fa = await fetchFasta('protein', r.accession, { signal: c.signal });
      const seq = fa ? parseFasta(fa)[0]?.seq : undefined;
      const ip = upsertByKey(c, protTable, 'accession', r.accession, { name: r.title.replace(/\s*\[.*\]$/, ''), sequence: seq, length: r.length || seq?.length, source: 'NCBI RefSeq', retrieved: now(), isoform: 'RefSeq product' },
        { sourceDb: 'NCBI Protein', accession: r.accession, query: `GeneID ${geneId}`, url: sourceUrl.protein(r.accession), step: 'import' });
      linkByTables(geneTable, geneRecordId, protTable, ip.id, { relationType: 'encodes', evidenceClass: 'database_annotated', sourceDb: 'NCBI RefSeq', sourceId: r.accession, referenceUrl: sourceUrl.protein(r.accession), evidence: `NCBI links RefSeq protein ${r.accession} to Gene ${geneId}` });
      out.push({ recordId: ip.id, accession: r.accession, name: r.title, isoform: 'RefSeq product', reviewed: false });
    }
    if (out.length) notes.push('No UniProt entry found; proteins come from NCBI RefSeq (no UniProt accession, so AlphaFold lookup is not possible).');
  }
  if (!out.length) notes.push('No protein products were found. This gene may be non-coding or poorly annotated – no protein was assumed.');
  for (const p of out.filter((x) => x.isoform === 'canonical')) {
    try { await enrichDomains(c, p.recordId); } catch (e) { notes.push(`InterPro domains unavailable for ${p.accession}: ${(e as Error).message}`); }
  }
  void entrezSearch; void addProvenance;
  return { proteins: out, notes };
}

export { uniprotUrl };
