// InterPro (EBI) – protein families and domains for a UniProt accession.
import { getJson } from './http.ts';

export interface InterProEntry { accession: string; name: string; type: string; source: string; locations: { start: number; end: number }[] }

export const interproUrl = (acc: string) => `https://www.ebi.ac.uk/interpro/entry/InterPro/${acc}/`;

export function parseInterPro(j: any): InterProEntry[] {
  return (j?.results ?? []).map((r: any): InterProEntry => {
    const m = r.metadata ?? {};
    const locs = (r.proteins?.[0]?.entry_protein_locations ?? []).flatMap((l: any) => (l.fragments ?? []).map((f: any) => ({ start: f.start, end: f.end })));
    return { accession: m.accession, name: m.name ?? m.accession, type: m.type ?? '', source: m.source_database ?? 'interpro', locations: locs };
  }).filter((e: InterProEntry) => e.accession);
}

export async function interproForProtein(uniprot: string, signal?: AbortSignal): Promise<InterProEntry[]> {
  const acc = uniprot.replace(/-\d+$/, '').toUpperCase();
  const j = await getJson<any>(`https://www.ebi.ac.uk/interpro/api/entry/interpro/protein/uniprot/${encodeURIComponent(acc)}?page_size=100`, { ttl: 7 * 24 * 3600, signal, timeoutMs: 60_000 });
  return parseInterPro(j);
}

export async function interproSearch(text: string, size = 8, signal?: AbortSignal): Promise<{ accession: string; name: string; type: string }[]> {
  const j = await getJson<any>(`https://www.ebi.ac.uk/interpro/api/entry/interpro/?search=${encodeURIComponent(text)}&page_size=${size}`, { ttl: 3600, signal, timeoutMs: 40_000 });
  return (j?.results ?? []).map((r: any) => ({ accession: r.metadata?.accession, name: r.metadata?.name ?? '', type: r.metadata?.type ?? '' })).filter((x: any) => x.accession);
}
export async function interproEntry(acc: string, signal?: AbortSignal): Promise<{ accession: string; name: string; type: string } | null> {
  const j = await getJson<any>(`https://www.ebi.ac.uk/interpro/api/entry/interpro/${encodeURIComponent(acc.toUpperCase())}`, { ttl: 7 * 24 * 3600, signal });
  const m = j?.metadata;
  return m ? { accession: m.accession, name: m.name?.name ?? m.name ?? '', type: m.type ?? '' } : null;
}
