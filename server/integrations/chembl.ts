// ChEMBL web services – curated mechanisms of action and measured bioactivities for a UniProt target.
// NOTE (measured 2026-11-05): single calls can take 20+ s and the service intermittently returns HTTP 500; the HTTP layer
// uses long timeouts, retries and a 3-day cache. Callers must treat ChEMBL failures as partial results, not fatal errors.
import { getJson } from './http.ts';
import type { EvidenceClass } from '../../shared/types.ts';

const BASE = 'https://www.ebi.ac.uk/chembl/api/data';
export const chemblUrl = (id: string) => `https://www.ebi.ac.uk/chembl/explore/compound/${id}`;
export const chemblTargetUrl = (id: string) => `https://www.ebi.ac.uk/chembl/explore/target/${id}`;
export const chemblDocUrl = (id: string) => `https://www.ebi.ac.uk/chembl/explore/document/${id}`;
const ttl = 3 * 24 * 3600;

export interface ChemblTarget { id: string; name: string; type: string; organism: string }

export async function targetsForUniprot(uniprot: string, signal?: AbortSignal): Promise<ChemblTarget[]> {
  const acc = uniprot.replace(/-\d+$/, '').toUpperCase();
  const j = await getJson<any>(`${BASE}/target.json?target_components__accession=${acc}&limit=20`, { ttl, signal, timeoutMs: 120_000 });
  return (j?.targets ?? [])
    .map((t: any): ChemblTarget => ({ id: t.target_chembl_id, name: t.pref_name ?? '', type: t.target_type ?? '', organism: t.organism ?? '' }))
    // a "SINGLE PROTEIN" target is the protein itself; complexes/families are less specific so rank them last
    .sort((a: ChemblTarget, b: ChemblTarget) => Number(b.type === 'SINGLE PROTEIN') - Number(a.type === 'SINGLE PROTEIN'));
}

export interface Mechanism { moleculeId: string; action: string; mechanism: string; directInteraction: boolean; refs: { type: string; id: string; url: string }[] }
export async function mechanisms(targetId: string, signal?: AbortSignal): Promise<Mechanism[]> {
  const j = await getJson<any>(`${BASE}/mechanism.json?target_chembl_id=${targetId}&limit=200`, { ttl, signal, timeoutMs: 120_000 });
  return (j?.mechanisms ?? []).map((m: any): Mechanism => ({
    moleculeId: m.molecule_chembl_id, action: String(m.action_type ?? '').toUpperCase(), mechanism: m.mechanism_of_action ?? '', directInteraction: !!m.direct_interaction,
    refs: (m.mechanism_refs ?? []).map((r: any) => ({ type: r.ref_type, id: r.ref_id, url: r.ref_url })),
  })).filter((m: Mechanism) => m.moleculeId);
}

export interface Activity {
  moleculeId: string; moleculeName: string | null; smiles: string | null; type: string; relation: string; value: number | null; units: string; pchembl: number | null;
  assayId: string; assayType: string; assayDescription: string; documentId: string; year: number | null; pubmed: string | null;
}
export async function activities(targetId: string, o: { minPchembl?: number; limit?: number; signal?: AbortSignal } = {}): Promise<Activity[]> {
  const params = new URLSearchParams({
    target_chembl_id: targetId, pchembl_value__gte: String(o.minPchembl ?? 6), limit: String(o.limit ?? 60), order_by: '-pchembl_value', standard_relation: '=',
  });
  const j = await getJson<any>(`${BASE}/activity.json?${params}`, { ttl, signal: o.signal, timeoutMs: 150_000 });
  return (j?.activities ?? [])
    .filter((a: any) => !a.data_validity_comment && !a.potential_duplicate) // drop ChEMBL-flagged questionable data
    .map((a: any): Activity => ({
      moleculeId: a.molecule_chembl_id, moleculeName: a.molecule_pref_name ?? null, smiles: a.canonical_smiles ?? null, type: a.standard_type ?? '', relation: a.standard_relation ?? '',
      value: a.standard_value !== null && a.standard_value !== undefined ? Number(a.standard_value) : null, units: a.standard_units ?? '', pchembl: a.pchembl_value ? Number(a.pchembl_value) : null,
      assayId: a.assay_chembl_id, assayType: a.assay_type ?? '', assayDescription: a.assay_description ?? '', documentId: a.document_chembl_id ?? '', year: a.document_year ?? null, pubmed: a.pubmed_id ? String(a.pubmed_id) : null,
    })).filter((a: Activity) => a.moleculeId);
}

export interface ChemblMolecule { id: string; name: string | null; phase: number | null; smiles: string | null; inchi: string | null; inchiKey: string | null; formula: string | null; mw: number | null }
export async function molecules(ids: string[], signal?: AbortSignal): Promise<ChemblMolecule[]> {
  const out: ChemblMolecule[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40).join(',');
    const j = await getJson<any>(`${BASE}/molecule.json?molecule_chembl_id__in=${part}&limit=40`, { ttl, signal, timeoutMs: 120_000 });
    for (const m of j?.molecules ?? []) {
      out.push({
        id: m.molecule_chembl_id, name: m.pref_name ?? null, phase: m.max_phase !== undefined && m.max_phase !== null ? Number(m.max_phase) : null,
        smiles: m.molecule_structures?.canonical_smiles ?? null, inchi: m.molecule_structures?.standard_inchi ?? null, inchiKey: m.molecule_structures?.standard_inchi_key ?? null,
        formula: m.molecule_properties?.full_molformula ?? null, mw: m.molecule_properties?.full_mwt ? Number(m.molecule_properties.full_mwt) : null,
      });
    }
  }
  return out;
}

// ---- relationship classification (kept pure so it is unit-testable) ----
const ACTION_LABEL: Record<string, string> = {
  INHIBITOR: 'inhibitor', ANTAGONIST: 'antagonist', BLOCKER: 'blocker', 'NEGATIVE ALLOSTERIC MODULATOR': 'negative allosteric modulator', 'NEGATIVE MODULATOR': 'negative modulator',
  ACTIVATOR: 'activator', AGONIST: 'agonist', 'POSITIVE ALLOSTERIC MODULATOR': 'positive allosteric modulator', 'POSITIVE MODULATOR': 'positive modulator', OPENER: 'opener',
  SUBSTRATE: 'substrate', COFACTOR: 'cofactor', BINDING_AGENT: 'binding agent', 'BINDING AGENT': 'binding agent', MODULATOR: 'modulator', 'ALLOSTERIC ANTAGONIST': 'allosteric antagonist', 'PARTIAL AGONIST': 'partial agonist',
  'INVERSE AGONIST': 'inverse agonist', STABILISER: 'stabiliser', DEGRADER: 'degrader', 'RELEASING AGENT': 'releasing agent', 'SEQUESTERING AGENT': 'sequestering agent',
};

export function classifyMechanism(m: Mechanism): { relationType: string; evidenceClass: EvidenceClass; evidence: string } {
  const label = ACTION_LABEL[m.action] ?? (m.action ? m.action.toLowerCase() : 'ligand');
  return {
    relationType: label,
    // a curated mechanism-of-action record is a database annotation, citing the supporting references
    evidenceClass: 'database_annotated',
    evidence: `ChEMBL curated mechanism of action: ${m.mechanism || label}${m.refs.length ? ` (refs: ${m.refs.slice(0, 3).map((r) => `${r.type} ${r.id}`).join('; ')})` : ''}`,
  };
}

/** What a measured activity actually supports. We never call a compound an "inhibitor" from a Ki, or an "activator" from an EC50. */
export function classifyActivity(a: Activity): { relationType: string; evidenceClass: EvidenceClass; evidence: string } | null {
  if (a.value === null || !a.units) return null;
  if (a.assayType !== 'B' && a.assayType !== 'F') return null; // binding or functional assays only; ADME/toxicity are not target relationships
  const t = a.type.toUpperCase();
  const rt = t === 'IC50' || t === 'INHIBITION' ? 'inhibitor (measured IC50)' : t === 'KI' ? 'ligand (measured Ki)' : t === 'KD' ? 'ligand (measured Kd)'
    : t === 'EC50' || t === 'AC50' ? 'modulator (measured EC50)' : `active compound (measured ${a.type})`;
  return {
    relationType: rt,
    evidenceClass: 'experimentally_verified',
    evidence: `${a.type} ${a.relation}${a.value} ${a.units}${a.pchembl ? ` (pChEMBL ${a.pchembl})` : ''} in ${a.assayType === 'B' ? 'binding' : 'functional'} assay ${a.assayId}${a.documentId ? ` (document ${a.documentId}${a.year ? ', ' + a.year : ''})` : ''}${a.pubmed ? `, PMID ${a.pubmed}` : ''}`,
  };
}
