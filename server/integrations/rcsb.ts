// RCSB Protein Data Bank – experimental structures, search by UniProt accession and bound (co-crystallised) ligands.
import { getJson, request } from './http.ts';

export const pdbUrl = (id: string) => `https://www.rcsb.org/structure/${id.toUpperCase()}`;
export const pdbFileUrl = (id: string, ext: 'pdb' | 'cif' = 'pdb') => `https://files.rcsb.org/download/${id.toUpperCase()}.${ext}`;

export interface PdbEntry {
  id: string; title: string; method: string; resolution: number | null; depositDate: string | null; releaseDate: string | null;
  pubmedId: string | null; doi: string | null; polymerEntities: number; organisms: string[];
}

export async function pdbEntry(id: string, signal?: AbortSignal): Promise<PdbEntry | null> {
  const j = await getJson<any>(`https://data.rcsb.org/rest/v1/core/entry/${encodeURIComponent(id.toUpperCase())}`, { ttl: 7 * 24 * 3600, signal });
  if (!j) return null;
  const info = j.rcsb_entry_info ?? {};
  return {
    id: j.rcsb_id ?? id.toUpperCase(), title: j.struct?.title ?? '', method: j.exptl?.[0]?.method ?? info.experimental_method ?? '',
    resolution: info.resolution_combined?.[0] ?? null, depositDate: j.rcsb_accession_info?.deposit_date ?? null, releaseDate: j.rcsb_accession_info?.initial_release_date ?? null,
    pubmedId: j.rcsb_primary_citation?.pdbx_database_id_PubMed ? String(j.rcsb_primary_citation.pdbx_database_id_PubMed) : null, doi: j.rcsb_primary_citation?.pdbx_database_id_DOI ?? null,
    polymerEntities: info.polymer_entity_count ?? 0, organisms: [],
  };
}

/** PDB entry ids whose polymer entities reference the UniProt accession, best resolution first. */
export async function pdbIdsForUniprot(uniprot: string, rows = 10, signal?: AbortSignal): Promise<string[]> {
  const body = JSON.stringify({
    query: { type: 'terminal', service: 'text', parameters: { attribute: 'rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession', operator: 'exact_match', value: uniprot.replace(/-\d+$/, '').toUpperCase() } },
    return_type: 'entry', request_options: { paginate: { start: 0, rows }, sort: [{ sort_by: 'rcsb_entry_info.resolution_combined', direction: 'asc' }] },
  });
  const r = await request('https://search.rcsb.org/rcsbsearch/v2/query', { method: 'POST', body, headers: { 'content-type': 'application/json' }, ttl: 24 * 3600, signal, okStatuses: [204] });
  if (r.status === 204 || !r.text.trim()) return [];
  return (r.json<any>().result_set ?? []).map((x: any) => x.identifier);
}

/** Free-text search of PDB entries (titles, keywords, ligand names). */
export async function pdbSearchText(text: string, rows = 8, signal?: AbortSignal): Promise<string[]> {
  const body = JSON.stringify({ query: { type: 'terminal', service: 'full_text', parameters: { value: text } }, return_type: 'entry', request_options: { paginate: { start: 0, rows } } });
  const r = await request('https://search.rcsb.org/rcsbsearch/v2/query', { method: 'POST', body, headers: { 'content-type': 'application/json' }, ttl: 3600, signal, okStatuses: [204] });
  if (r.status === 204 || !r.text.trim()) return [];
  return (r.json<any>().result_set ?? []).map((x: any) => x.identifier);
}

export interface PdbLigand { compId: string; name: string; formula: string; weight: number | null; smiles: string | null; inchi: string | null; inchiKey: string | null; type: string }

/** Ions, solvents, buffers and cryo-protectants that are almost always crystallisation additives, not biologically meaningful ligands. */
const ADDITIVES = new Set(['HOH', 'DOD', 'GOL', 'EDO', 'PEG', 'PGE', 'PG4', 'P6G', '1PE', 'PE4', '2PE', 'SO4', 'PO4', 'SUL', 'ACT', 'ACY', 'DMS', 'FMT', 'TRS', 'MPD', 'BME', 'EPE', 'MES', 'IMD', 'NO3', 'CO3', 'CIT', 'TAR', 'MLI', 'FLC', 'BOG', 'LDA', 'DTT', 'NH4', 'SCN', 'AZI', 'PGO', 'PEU', 'IPA', 'EOH', 'MOH', 'BCT', 'GBL', 'OXY', 'CAC', 'TLA', 'URE', 'NHE', 'HEZ', 'MRD', 'BU3', 'PGR', 'ETA', 'ACN']);
const IONS = new Set(['NA', 'K', 'CL', 'MG', 'CA', 'ZN', 'MN', 'FE', 'FE2', 'CU', 'CU1', 'NI', 'CO', 'CD', 'BR', 'IOD', 'F', 'LI', 'RB', 'CS', 'SR', 'BA', 'HG', 'PT', 'AU', 'AG', 'YB', 'TB', 'GD', 'SM', 'EU', 'LA', 'PB', 'AL', 'V', 'W', 'MO', 'TL', 'OS', 'IR', 'RU', 'PD', 'XE', 'KR', 'AR', 'MG2', 'NA1']);
export const isAdditive = (id: string) => ADDITIVES.has(id.toUpperCase());
export const isIon = (id: string) => IONS.has(id.toUpperCase());

export function parseLigands(j: any): PdbLigand[] {
  const out: PdbLigand[] = [];
  for (const e of j?.data?.entry?.nonpolymer_entities ?? []) {
    const cc = e.nonpolymer_comp?.chem_comp;
    if (!cc?.id) continue;
    const d = e.nonpolymer_comp?.rcsb_chem_comp_descriptor ?? {};
    out.push({ compId: cc.id, name: cc.name ?? '', formula: cc.formula ?? '', weight: cc.formula_weight ?? null, smiles: d.SMILES_stereo ?? d.SMILES ?? null, inchi: d.InChI ?? null, inchiKey: d.InChIKey ?? null, type: cc.type ?? '' });
  }
  return out;
}

/** Non-polymer components of an entry (ligands, cofactors, ions) with structure descriptors, via RCSB's GraphQL endpoint. */
export async function pdbLigands(entryId: string, signal?: AbortSignal): Promise<PdbLigand[]> {
  const query = `query($id:String!){entry(entry_id:$id){nonpolymer_entities{nonpolymer_comp{chem_comp{id name formula formula_weight type} rcsb_chem_comp_descriptor{SMILES SMILES_stereo InChI InChIKey}}}}}`;
  const r = await request('https://data.rcsb.org/graphql', { method: 'POST', body: JSON.stringify({ query, variables: { id: entryId.toUpperCase() } }), headers: { 'content-type': 'application/json' }, ttl: 7 * 24 * 3600, signal });
  return parseLigands(r.json());
}
