// BindingDB REST – measured protein-ligand affinities (experimentally measured, literature-derived).
// The service is intermittently unavailable and its JSON field names have varied, so parsing is deliberately defensive
// and every failure degrades to "no BindingDB data" instead of failing a whole discovery run.
import { request } from './http.ts';

export const bindingdbUrl = (monomerId: string | number) => `https://www.bindingdb.org/rwd/bind/chemsearch/marvin/MolStructure.jsp?monomerid=${monomerId}`;

export interface BdbAffinity { monomerId: string; smiles: string; type: string; value: number | null; relation: '' | '<' | '>' | '~'; unit: string; pmid: string | null; doi: string | null; inchiKey: string | null }

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/[<>~=\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const rel = (v: unknown): BdbAffinity['relation'] => { const c = String(v ?? '').trim()[0]; return c === '<' || c === '>' || c === '~' ? c : ''; };

export function parseBindingDb(j: any): BdbAffinity[] {
  // find the array of affinity records wherever it is nested
  const find = (x: any): any[] | null => {
    if (Array.isArray(x)) return x.length && typeof x[0] === 'object' && ('smiles' in x[0] || 'smile' in x[0] || 'monomerid' in x[0]) ? x : null;
    if (x && typeof x === 'object') for (const v of Object.values(x)) { const r = find(v); if (r) return r; }
    return null;
  };
  const rows = find(j) ?? [];
  return rows.map((r: any): BdbAffinity => ({
    monomerId: String(r.monomerid ?? r.monomer_id ?? ''), smiles: r.smiles ?? r.smile ?? '', type: String(r.affinity_type ?? r.type ?? ''),
    value: num(r.affinity ?? r.value), relation: rel(r.affinity ?? r.value), unit: 'nM', pmid: r.pmid ? String(r.pmid) : null, doi: r.doi ?? null, inchiKey: r.inchi_key ?? r.inchikey ?? null,
  })).filter((a) => a.monomerId && a.smiles && a.relation !== '>'); // "IC50 > 10000 nM" means no measurable binding: never evidence of a ligand
}

export async function affinitiesForUniprot(uniprot: string, o: { cutoffNm?: number; signal?: AbortSignal } = {}): Promise<BdbAffinity[] | null> {
  const acc = uniprot.replace(/-\d+$/, '').toUpperCase();
  try {
    const r = await request(`https://www.bindingdb.org/rest/getLigandsByUniprots?uniprot=${acc}&cutoff=${o.cutoffNm ?? 1000}&response=application/json`,
      { ttl: 3 * 24 * 3600, signal: o.signal, retries: 1, timeoutMs: 90_000, okStatuses: [400, 404] });
    if (r.status !== 200 || !r.text.trim().startsWith('{') && !r.text.trim().startsWith('[')) return [];
    return parseBindingDb(r.json());
  } catch (e) {
    if ((e as Error).message === 'Cancelled') throw e;
    return null; // null = service unavailable (reported as a warning), [] = no ligands
  }
}
