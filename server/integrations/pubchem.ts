// PubChem PUG REST – chemical identity (CID, InChIKey, SMILES) and bioactivity summaries.
import { getJson, request } from './http.ts';

const PUG = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
export const pubchemUrl = (cid: string | number) => `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`;

export interface ChemProps {
  cid: string; title: string; iupacName: string; formula: string; molecularWeight: number | null; smiles: string; isoSmiles: string; inchi: string; inchiKey: string;
}

const PROPS = 'Title,IUPACName,MolecularFormula,MolecularWeight,SMILES,ConnectivitySMILES,InChI,InChIKey';

/** PubChem renamed SMILES properties (Canonical/IsomericSMILES -> ConnectivitySMILES/SMILES); accept both generations. */
export function parseProps(j: any): ChemProps[] {
  return (j?.PropertyTable?.Properties ?? []).map((p: any): ChemProps => ({
    cid: String(p.CID), title: p.Title ?? '', iupacName: p.IUPACName ?? '', formula: p.MolecularFormula ?? '',
    molecularWeight: p.MolecularWeight !== undefined ? Number(p.MolecularWeight) : null,
    smiles: p.ConnectivitySMILES ?? p.CanonicalSMILES ?? p.SMILES ?? '', isoSmiles: p.SMILES ?? p.IsomericSMILES ?? p.ConnectivitySMILES ?? '',
    inchi: p.InChI ?? '', inchiKey: p.InChIKey ?? '',
  }));
}

export async function propsForCids(cids: (string | number)[], signal?: AbortSignal): Promise<ChemProps[]> {
  if (!cids.length) return [];
  const out: ChemProps[] = [];
  for (let i = 0; i < cids.length; i += 50) {
    const part = cids.slice(i, i + 50).join(',');
    const j = await getJson<any>(`${PUG}/compound/cid/${part}/property/${PROPS}/JSON`, { ttl: 14 * 24 * 3600, signal });
    out.push(...parseProps(j));
  }
  return out;
}

async function cids(path: string, signal?: AbortSignal, o: { body?: string } = {}): Promise<string[]> {
  const r = await request(`${PUG}/${path}`, o.body
    ? { method: 'POST', body: o.body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, ttl: 14 * 24 * 3600, signal, okStatuses: [400] }
    : { ttl: 14 * 24 * 3600, signal, okStatuses: [400] });
  if (r.status === 404 || r.status === 400) return [];
  return (r.json<any>().IdentifierList?.CID ?? []).filter((c: number) => c > 0).map(String);
}
export const cidsByName = (name: string, signal?: AbortSignal) => cids(`compound/name/${encodeURIComponent(name)}/cids/JSON`, signal);
export const cidsByInchiKey = (key: string, signal?: AbortSignal) => cids(`compound/inchikey/${encodeURIComponent(key)}/cids/JSON`, signal);
export const cidsBySmiles = (smiles: string, signal?: AbortSignal) => cids('compound/smiles/cids/JSON', signal, { body: `smiles=${encodeURIComponent(smiles)}` });
export const cidsByInchi = (inchi: string, signal?: AbortSignal) => cids('compound/inchi/cids/JSON', signal, { body: `inchi=${encodeURIComponent(inchi)}` });

/** Resolve any supported chemical identifier / name to PubChem CIDs. */
export async function resolveChemical(q: string, signal?: AbortSignal): Promise<string[]> {
  const s = q.trim();
  if (/^(?:CID:?\s*)?\d+$/i.test(s)) return [s.replace(/\D/g, '')];
  if (/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/.test(s)) return cidsByInchiKey(s, signal);
  if (/^InChI=/i.test(s)) return cidsByInchi(s, signal);
  if (/^[A-Za-z0-9@+\-\[\]()=#$%/\\.:*]+$/.test(s) && /[=()#\[\]]/.test(s) && !/\s/.test(s)) {
    const bySmiles = await cidsBySmiles(s, signal);
    if (bySmiles.length) return bySmiles;
  }
  return cidsByName(s, signal);
}

export async function synonyms(cid: string, limit = 10, signal?: AbortSignal): Promise<string[]> {
  const j = await getJson<any>(`${PUG}/compound/cid/${cid}/synonyms/JSON`, { ttl: 14 * 24 * 3600, signal });
  return (j?.InformationList?.Information?.[0]?.Synonym ?? []).slice(0, limit);
}

export interface Bioactivity { totalAssays: number; activeAssays: number; targets: { accession: string; geneId: string; activeCount: number }[] }

/** Summarise PubChem's BioAssay results for a compound. Only "Active" outcomes count as active. */
export async function bioactivity(cid: string, signal?: AbortSignal): Promise<Bioactivity | null> {
  const j = await getJson<any>(`${PUG}/compound/cid/${cid}/assaysummary/JSON`, { ttl: 7 * 24 * 3600, signal, timeoutMs: 90_000 });
  return parseAssaySummary(j);
}
export function parseAssaySummary(j: any): Bioactivity | null {
  const t = j?.Table;
  if (!t) return null;
  const cols: string[] = t.Columns?.Column ?? [];
  const ix = (n: string) => cols.indexOf(n);
  const iOutcome = ix('Activity Outcome'), iAcc = ix('Target Accession'), iGene = ix('Target GeneID');
  let active = 0;
  const tg = new Map<string, { accession: string; geneId: string; activeCount: number }>();
  const rows: any[] = t.Row ?? [];
  for (const r of rows) {
    const c: string[] = r.Cell ?? [];
    if ((c[iOutcome] ?? '').toLowerCase() !== 'active') continue;
    active++;
    const acc = c[iAcc], gene = c[iGene];
    if (acc || gene) {
      const key = acc || gene;
      const e = tg.get(key) ?? { accession: acc ?? '', geneId: gene ?? '', activeCount: 0 };
      e.activeCount++;
      tg.set(key, e);
    }
  }
  return { totalAssays: rows.length, activeAssays: active, targets: [...tg.values()].sort((a, b) => b.activeCount - a.activeCount).slice(0, 25) };
}
