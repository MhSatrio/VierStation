// Protein -> Structure (FR-1.12 … FR-1.15). Pre-calculated AlphaFold models and experimental PDB entries only.
// A predicted structure is labelled as computationally predicted and never as evidence of binding.
import type { Ctx } from '../ingest.ts';
import { addProvenance, fillRecord, linkByTables, tableOfKind, upsertByKey, valueOf } from '../ingest.ts';
import { alphafoldModels, afPage } from '../integrations/alphafold.ts';
import { pdbEntry, pdbFileUrl, pdbUrl } from '../integrations/rcsb.ts';
import { uniprotEntry } from '../integrations/uniprot.ts';
import { getRaw } from '../records.ts';
import { now } from '../util.ts';
import { Fatal } from '../jobs.ts';

export interface StructureDiscovery {
  uniprot: string;
  alphafold: { available: boolean; entryId?: string; meanPlddt?: number | null; recordId?: string; reason?: string };
  experimental: { id: string; method: string; resolution: number | null; recordId: string }[];
  availability: 'AlphaFold available' | 'Experimental only' | 'Unavailable';
  notes: string[];
}

const METHOD: Record<string, string> = { 'X-RAY DIFFRACTION': 'X-ray', 'ELECTRON MICROSCOPY': 'Cryo-EM', 'SOLUTION NMR': 'NMR', 'SOLID-STATE NMR': 'NMR', 'ELECTRON CRYSTALLOGRAPHY': 'Other experimental', 'NEUTRON DIFFRACTION': 'Other experimental' };
const methodLabel = (m: string) => METHOD[m.toUpperCase()] ?? (m ? 'Other experimental' : 'Other experimental');

export async function discoverStructures(c: Ctx, proteinRecordId: string, o: { maxPdb?: number } = {}): Promise<StructureDiscovery> {
  const protTable = getRaw(proteinRecordId)?.tableId;
  if (!protTable) throw new Fatal('Protein record not found');
  const structTable = tableOfKind(c, 'structure');
  const accession = String(valueOf(protTable, proteinRecordId, 'accession') ?? '').trim();
  const uniprot = accession.replace(/-\d+$/, '').toUpperCase();
  const notes: string[] = [];
  if (!/^[A-Z][0-9][A-Z0-9]{3}[0-9]|^[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2}/.test(uniprot)) throw new Fatal(`"${accession}" is not a UniProt accession, so AlphaFold DB cannot be queried. Add a UniProt accession to this protein.`);
  if (accession.includes('-')) notes.push(`${accession} is an isoform: AlphaFold DB models the canonical sequence ${uniprot}; residues may differ from this isoform.`);

  const result: StructureDiscovery = { uniprot, alphafold: { available: false }, experimental: [], availability: 'Unavailable', notes };

  // 1) AlphaFold DB – look up, never compute
  const models = await alphafoldModels(uniprot, c.signal);
  const m = models[0];
  if (m) {
    const mean = m.meanPlddt;
    const url = afPage(uniprot);
    const r = upsertByKey(c, structTable, 'accession', m.entryId, {
      name: `${m.entryId} (${m.gene ?? uniprot})`, source: 'AlphaFold DB', method: 'Predicted', plddt: mean ?? undefined, retrieved: now(),
      structure: { source: 'alphafold', id: m.entryId, uniprot, version: m.version, meanPlddt: mean, fileUrl: m.pdbUrl, paeUrl: m.paeImageUrl ?? undefined, url, predicted: true, retrievedAt: now(), length: m.sequenceEnd - m.sequenceStart + 1 },
    }, { sourceDb: 'AlphaFold DB', accession: m.entryId, query: uniprot, url, step: 'import', note: `${m.tool} model v${m.version}; mean pLDDT ${mean}. Predicted structure – not experimental evidence.` }, { overwrite: ['structure', 'plddt'] });
    linkByTables(protTable, proteinRecordId, structTable, r.id, {
      relationType: 'predicted structure', evidenceClass: 'computationally_predicted', sourceDb: 'AlphaFold DB', sourceId: m.entryId, referenceUrl: url,
      evidence: `${m.tool} model ${m.entryId} v${m.version}, mean pLDDT ${mean}. This is a computational prediction.`,
    });
    result.alphafold = { available: true, entryId: m.entryId, meanPlddt: mean, recordId: r.id };
  } else {
    result.alphafold = { available: false, reason: `AlphaFold DB has no model for ${uniprot} (checked ${now().slice(0, 16).replace('T', ' ')} UTC)` };
    addProvenance(proteinRecordId, { sourceDb: 'AlphaFold DB', accession: uniprot, query: uniprot, url: afPage(uniprot), step: 'structure', note: result.alphafold.reason });
    notes.push(result.alphafold.reason!);
  }

  // 2) experimental structures from UniProt's PDB cross-references (also the fallback when AlphaFold has nothing)
  const entry = await uniprotEntry(uniprot, c.signal);
  const pdbs = (entry?.pdb ?? []).slice().sort((a, b) => (a.resolution ?? 99) - (b.resolution ?? 99)).slice(0, o.maxPdb ?? 5);
  for (const p of pdbs) {
    const e = await pdbEntry(p.id, c.signal);
    const method = e?.method || p.method;
    const r = upsertByKey(c, structTable, 'accession', p.id.toUpperCase(), {
      name: `${p.id.toUpperCase()} ${e?.title ? '– ' + e.title.slice(0, 80) : ''}`.trim(), source: 'RCSB PDB', method: methodLabel(method), resolution: e?.resolution ?? p.resolution ?? undefined, retrieved: now(),
      structure: { source: 'pdb', id: p.id.toUpperCase(), uniprot, method, title: e?.title, resolution: e?.resolution ?? p.resolution ?? undefined, fileUrl: pdbFileUrl(p.id), url: pdbUrl(p.id), predicted: false, chains: p.chains, retrievedAt: now() },
    }, { sourceDb: 'RCSB PDB', accession: p.id.toUpperCase(), query: uniprot, url: pdbUrl(p.id), step: 'import', note: `${method}${e?.resolution ? `, ${e.resolution} Å` : ''}` });
    linkByTables(protTable, proteinRecordId, structTable, r.id, {
      relationType: 'experimental structure', evidenceClass: 'experimentally_verified', sourceDb: 'RCSB PDB', sourceId: p.id.toUpperCase(), referenceUrl: pdbUrl(p.id),
      evidence: `${method} structure ${p.id.toUpperCase()}${e?.resolution ? ` at ${e.resolution} Å` : ''}; chains ${p.chains || 'n/a'}`,
    });
    result.experimental.push({ id: p.id.toUpperCase(), method, resolution: e?.resolution ?? p.resolution, recordId: r.id });
  }
  if (!m && !pdbs.length) notes.push('No experimental structure either. No prediction was launched – use the AlphaFold Server or ColabFold yourself if you need one.');

  result.availability = m ? 'AlphaFold available' : pdbs.length ? 'Experimental only' : 'Unavailable';
  fillRecord(c, protTable, proteinRecordId, { structAvail: result.availability }, { sourceDb: 'AlphaFold DB / RCSB PDB', accession: uniprot, step: 'structure', note: `Structure availability: ${result.availability}` }, ['structAvail']);
  return result;
}
