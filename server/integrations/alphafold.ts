// AlphaFold Protein Structure Database (EBI). Pre-calculated structures only: this module never runs a folding model.
import { getJson, request } from './http.ts';

export interface AfModel {
  entryId: string; uniprot: string; gene: string | null; description: string; organism: string; taxId: number | null; version: number;
  meanPlddt: number | null; fractions: { veryLow: number; low: number; confident: number; veryHigh: number };
  pdbUrl: string; cifUrl: string; bcifUrl: string | null; paeImageUrl: string | null; paeDocUrl: string | null;
  sequenceStart: number; sequenceEnd: number; sequence: string; createdDate: string | null; isReviewed: boolean; tool: string; provider: string;
}

export const afPage = (acc: string) => `https://alphafold.ebi.ac.uk/entry/${encodeURIComponent(acc)}`;

export function parseModels(j: any): AfModel[] {
  if (!Array.isArray(j)) return [];
  return j.map((m: any): AfModel => ({
    entryId: m.modelEntityId ?? `AF-${m.uniprotAccession}-F1`, uniprot: m.uniprotAccession, gene: m.gene ?? null, description: m.uniprotDescription ?? '', organism: m.organismScientificName ?? '',
    taxId: m.taxId ?? null, version: m.latestVersion ?? 0, meanPlddt: typeof m.globalMetricValue === 'number' ? m.globalMetricValue : null,
    fractions: { veryLow: m.fractionPlddtVeryLow ?? 0, low: m.fractionPlddtLow ?? 0, confident: m.fractionPlddtConfident ?? 0, veryHigh: m.fractionPlddtVeryHigh ?? 0 },
    pdbUrl: m.pdbUrl, cifUrl: m.cifUrl, bcifUrl: m.bcifUrl ?? null, paeImageUrl: m.paeImageUrl ?? null, paeDocUrl: m.paeDocUrl ?? null,
    sequenceStart: m.sequenceStart ?? 1, sequenceEnd: m.sequenceEnd ?? 0, sequence: m.sequence ?? '', createdDate: m.modelCreatedDate ?? null, isReviewed: !!m.isUniProtReviewed, tool: m.toolUsed ?? 'AlphaFold', provider: m.providerId ?? '',
  }));
}

/** All AlphaFold models for a UniProt accession; empty array when AlphaFold DB has none (a normal, expected outcome). */
export async function alphafoldModels(uniprot: string, signal?: AbortSignal): Promise<AfModel[]> {
  const acc = uniprot.replace(/-\d+$/, '').toUpperCase();
  const j = await getJson<any>(`https://alphafold.ebi.ac.uk/api/prediction/${encodeURIComponent(acc)}`, { ttl: 24 * 3600, signal, okStatuses: [400, 422] });
  // AlphaFold DB also hosts third-party models (e.g. ColabFold); list the DeepMind AlphaFold model first.
  return parseModels(j).sort((a, b) => Number(/alphafold/i.test(b.tool)) - Number(/alphafold/i.test(a.tool)) || Number(b.provider === 'GDM') - Number(a.provider === 'GDM'));
}

const HOSTS = new Set(['alphafold.ebi.ac.uk', 'files.rcsb.org', 'models.rcsb.org']);
/** Download a coordinate file from an allow-listed host (prevents the server being used as an open proxy). */
export async function downloadCoordinates(url: string, signal?: AbortSignal): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) throw new Error('Coordinate downloads are limited to AlphaFold DB and RCSB');
  const r = await request(url, { ttl: 0, accept: 'text/plain', signal, timeoutMs: 120_000 });
  if (r.status === 404) throw new Error('Structure file not found');
  return r.text;
}

/** Per-residue pLDDT from the B-factor column of CA atoms (AlphaFold stores pLDDT there). */
export function plddtFromPdb(pdb: string): { resi: number; aa: string; plddt: number }[] {
  const out: { resi: number; aa: string; plddt: number }[] = [];
  for (const line of pdb.split('\n')) {
    if (!line.startsWith('ATOM') || line.slice(12, 16).trim() !== 'CA') continue;
    out.push({ resi: parseInt(line.slice(22, 26), 10), aa: line.slice(17, 20).trim(), plddt: parseFloat(line.slice(60, 66)) });
  }
  return out;
}
