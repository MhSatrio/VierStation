// UniProt REST API (https://rest.uniprot.org). Entries are requested with an explicit field list to keep payloads small.
import { getJson, getText } from './http.ts';
import { cleanSeq } from '../../shared/sequence.ts';

const BASE = 'https://rest.uniprot.org/uniprotkb';
const FIELDS = [
  'accession', 'id', 'gene_names', 'protein_name', 'organism_name', 'organism_id', 'length', 'mass', 'sequence', 'cc_function', 'cc_alternative_products',
  'xref_pdb', 'xref_alphafolddb', 'xref_interpro', 'xref_geneid', 'xref_refseq', 'xref_chembl', 'xref_bindingdb', 'reviewed', 'protein_existence', 'lit_pubmed_id', 'ft_domain', 'ft_region',
].join(',');

export interface UniProtIsoform { id: string; name: string; status: string }
export interface UniProtPdb { id: string; method: string; resolution: number | null; chains: string }
export interface UniProtEntry {
  accession: string; entryName: string; name: string; geneSymbol: string; geneSynonyms: string[]; organism: string; taxId: number | null; length: number; mass: number | null;
  sequence: string; function: string; reviewed: boolean; existence: string; isoforms: UniProtIsoform[]; pdb: UniProtPdb[]; hasAlphaFold: boolean;
  interpro: string[]; geneIds: string[]; refseq: { protein: string; nucleotide: string | null }[]; chembl: string[]; bindingdb: string[]; pubmed: string[];
  domains: { type: string; description: string; start: number; end: number }[];
}

export const uniprotUrl = (acc: string) => `https://www.uniprot.org/uniprotkb/${encodeURIComponent(acc)}/entry`;

export function parseEntry(e: any): UniProtEntry {
  const xr: any[] = e.uniProtKBCrossReferences ?? [];
  const by = (db: string) => xr.filter((x) => x.database === db);
  const prop = (x: any, k: string) => x.properties?.find((p: any) => p.key === k)?.value as string | undefined;
  const fn = (e.comments ?? []).find((c: any) => c.commentType === 'FUNCTION')?.texts?.[0]?.value ?? '';
  const alt = (e.comments ?? []).find((c: any) => c.commentType === 'ALTERNATIVE PRODUCTS');
  const isoforms: UniProtIsoform[] = (alt?.isoforms ?? []).map((i: any) => ({ id: i.isoformIds?.[0] ?? '', name: i.name?.value ?? '', status: i.isoformSequenceStatus ?? '' })).filter((i: UniProtIsoform) => i.id);
  const pdb: UniProtPdb[] = by('PDB').map((x) => ({
    id: x.id, method: prop(x, 'Method') ?? '', resolution: prop(x, 'Resolution') && prop(x, 'Resolution') !== '-' ? parseFloat(prop(x, 'Resolution')!) : null, chains: prop(x, 'Chains') ?? '',
  }));
  const gene = e.genes?.[0];
  const pm = new Set<string>();
  for (const r of e.references ?? []) {
    const x = r.citation?.citationCrossReferences?.find((c: any) => c.database === 'PubMed');
    if (x) pm.add(String(x.id));
  }
  const protName = e.proteinDescription?.recommendedName?.fullName?.value ?? e.proteinDescription?.submissionNames?.[0]?.fullName?.value ?? e.proteinDescription?.alternativeNames?.[0]?.fullName?.value ?? e.uniProtkbId ?? e.primaryAccession;
  return {
    accession: e.primaryAccession, entryName: e.uniProtkbId, name: protName, geneSymbol: gene?.geneName?.value ?? '', geneSynonyms: (gene?.synonyms ?? []).map((s: any) => s.value),
    organism: e.organism?.scientificName ?? '', taxId: e.organism?.taxonId ?? null, length: e.sequence?.length ?? 0, mass: e.sequence?.molWeight ?? null, sequence: cleanSeq(e.sequence?.value ?? ''),
    function: fn.replace(/\s*\(PubMed:[^)]*\)/g, '').trim(), reviewed: String(e.entryType ?? '').includes('Swiss-Prot'), existence: e.proteinExistence ?? '',
    isoforms, pdb, hasAlphaFold: by('AlphaFoldDB').length > 0, interpro: by('InterPro').map((x) => x.id),
    geneIds: by('GeneID').map((x) => x.id), refseq: by('RefSeq').map((x) => ({ protein: x.id, nucleotide: prop(x, 'NucleotideSequenceId') ?? null })),
    chembl: by('ChEMBL').map((x) => x.id), bindingdb: by('BindingDB').map((x) => x.id), pubmed: [...pm].slice(0, 30),
    domains: (e.features ?? []).filter((f: any) => f.type === 'Domain' || f.type === 'Region').slice(0, 40).map((f: any) => ({ type: f.type, description: f.description ?? '', start: f.location?.start?.value, end: f.location?.end?.value })),
  };
}

async function search(query: string, size: number, signal?: AbortSignal, ttl = 12 * 3600): Promise<UniProtEntry[]> {
  const u = `${BASE}/search?${new URLSearchParams({ query, format: 'json', size: String(size), fields: FIELDS })}`;
  const j = await getJson<any>(u, { ttl, signal, timeoutMs: 60_000 });
  return (j?.results ?? []).map(parseEntry);
}

/** Look up one entry by accession (isoform suffix is stripped; use isoformSequence() for isoforms). */
export async function uniprotEntry(accession: string, signal?: AbortSignal): Promise<UniProtEntry | null> {
  const acc = accession.replace(/-\d+$/, '').toUpperCase();
  const r = await search(`accession:${acc}`, 1, signal, 24 * 3600);
  if (r[0]) return r[0];
  // secondary / merged accessions
  const r2 = await search(`sec_acc:${acc}`, 1, signal, 24 * 3600);
  return r2[0] ?? null;
}

/** Entries cross-referenced to an NCBI Gene ID, reviewed (Swiss-Prot) first. */
export async function uniprotByGeneId(geneId: string, signal?: AbortSignal): Promise<UniProtEntry[]> {
  const r = await search(`xref:geneid-${geneId}`, 25, signal);
  return r.sort((a, b) => Number(b.reviewed) - Number(a.reviewed));
}

export async function uniprotByRefSeq(refseq: string, signal?: AbortSignal): Promise<UniProtEntry[]> {
  const bare = refseq.replace(/\.\d+$/, '');
  return search(`xref:refseq-${bare}`, 5, signal);
}

export async function uniprotSearch(text: string, o: { size?: number; taxId?: number | string; reviewedOnly?: boolean; signal?: AbortSignal } = {}): Promise<UniProtEntry[]> {
  let query = `(${text})`;
  if (o.taxId) query += ` AND (organism_id:${o.taxId})`;
  if (o.reviewedOnly) query += ' AND (reviewed:true)';
  const r = await search(query, o.size ?? 8, o.signal, 3600);
  return r;
}

export async function uniprotByGene(symbol: string, taxId?: number | string, signal?: AbortSignal): Promise<UniProtEntry[]> {
  const safe = symbol.replace(/[^\w\-.]/g, '');
  const r = await search(`(gene_exact:${safe})${taxId ? ` AND (organism_id:${taxId})` : ''}`, 10, signal);
  return r.sort((a, b) => Number(b.reviewed) - Number(a.reviewed));
}

/** FASTA of a specific isoform (e.g. P04637-2). */
export async function isoformSequence(isoformId: string, signal?: AbortSignal): Promise<string | null> {
  const t = await getText(`${BASE}/${encodeURIComponent(isoformId)}.fasta`, { ttl: 7 * 24 * 3600, signal });
  if (!t) return null;
  return cleanSeq(t.split('\n').filter((l) => !l.startsWith('>')).join(''));
}
