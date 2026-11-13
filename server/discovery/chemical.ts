// Protein -> Chemical discovery (FR-1.9, FR-1.10). Every protein-chemical link keeps source, evidence text, reference URL and
// an evidence class. Co-occurrence in a paper is never used as evidence. Chemicals are de-duplicated by InChIKey / ChEMBL ID / CID.
import { Fatal } from '../jobs.ts';
import type { Ctx } from '../ingest.ts';
import { addProvenance, fillRecord, linkByTables, linkWithEvidence, relationField, tableOfKind, upsertByKey, valueOf } from '../ingest.ts';
import type { EvidenceItem } from '../ingest.ts';
import * as chembl from '../integrations/chembl.ts';
import { affinitiesForUniprot, bindingdbUrl } from '../integrations/bindingdb.ts';
import { isAdditive, isIon, pdbLigands, pdbUrl } from '../integrations/rcsb.ts';
import { bioactivity, cidsByInchiKey, cidsBySmiles, propsForCids, pubchemUrl, resolveChemical, synonyms } from '../integrations/pubchem.ts';
import { uniprotEntry } from '../integrations/uniprot.ts';
import { getRaw, onRecordChange } from '../records.ts';
import { q, tx } from '../db.ts';
import { fieldByKey, listFields } from '../schema.ts';
import { now, safeJson } from '../util.ts';
import { RE } from '../../shared/sequence.ts';

export interface LigandCandidate {
  key: string; // dedupe key
  name?: string | null; chemblId?: string; inchiKey?: string | null; inchi?: string | null; smiles?: string | null; formula?: string | null; mw?: number | null; source: string;
  evidence: EvidenceItem[];
}

export interface ChemicalDiscovery { chemicals: { recordId: string; name: string; relationType: string; evidenceClass: string; sources: string }[]; notes: string[]; sources: Record<string, number | 'unavailable'> }

const keyOf = (c: { inchiKey?: string | null; chemblId?: string; smiles?: string | null; name?: string | null }) => c.inchiKey ?? (c.chemblId ? `chembl:${c.chemblId}` : c.smiles ? `smiles:${c.smiles}` : `name:${c.name}`);

function add(map: Map<string, LigandCandidate>, cand: Omit<LigandCandidate, 'key' | 'evidence'>, ev: EvidenceItem) {
  const key = keyOf(cand);
  const ex = map.get(key) ?? map.get(`chembl:${cand.chemblId}`);
  if (ex) {
    ex.evidence.push(ev);
    ex.name ??= cand.name; ex.inchiKey ??= cand.inchiKey; ex.smiles ??= cand.smiles; ex.inchi ??= cand.inchi; ex.chemblId ??= cand.chemblId; ex.formula ??= cand.formula; ex.mw ??= cand.mw;
  } else map.set(key, { ...cand, key, evidence: [ev] });
}

/** Collect candidate ligands from ChEMBL, PDB and BindingDB. Each source failing only produces a note. */
export async function collectLigands(c: Ctx, uniprot: string, o: { sources: string[]; maxCompounds: number; minPchembl: number }, notes: string[], sources: ChemicalDiscovery['sources']): Promise<LigandCandidate[]> {
  const map = new Map<string, LigandCandidate>();
  const entry = await uniprotEntry(uniprot, c.signal).catch(() => null);

  if (o.sources.includes('chembl')) {
    try {
      const targets = await chembl.targetsForUniprot(uniprot, c.signal);
      const t = targets.find((x) => x.type === 'SINGLE PROTEIN') ?? targets[0];
      if (!t) { sources.chembl = 0; notes.push(`ChEMBL has no target for ${uniprot}.`); }
      else {
        c.log(`ChEMBL target ${t.id} (${t.name}, ${t.type})`);
        const mech = await chembl.mechanisms(t.id, c.signal);
        const act = await chembl.activities(t.id, { minPchembl: o.minPchembl, limit: Math.min(100, o.maxCompounds * 2), signal: c.signal });
        const ids = [...new Set([...mech.map((m) => m.moleculeId), ...act.map((a) => a.moleculeId)])];
        const mols = new Map((await chembl.molecules(ids.slice(0, 80), c.signal)).map((m) => [m.id, m]));
        for (const m of mech) {
          const mol = mols.get(m.moleculeId);
          const cl = chembl.classifyMechanism(m);
          add(map, { name: mol?.name, chemblId: m.moleculeId, inchiKey: mol?.inchiKey, inchi: mol?.inchi, smiles: mol?.smiles, formula: mol?.formula, mw: mol?.mw, source: 'ChEMBL' },
            { ...cl, sourceDb: 'ChEMBL', sourceId: m.moleculeId, referenceUrl: m.refs[0]?.url ?? chembl.chemblUrl(m.moleculeId) });
        }
        for (const a of act) {
          const cl = chembl.classifyActivity(a);
          if (!cl) continue;
          const mol = mols.get(a.moleculeId);
          add(map, { name: mol?.name ?? a.moleculeName, chemblId: a.moleculeId, inchiKey: mol?.inchiKey, inchi: mol?.inchi, smiles: mol?.smiles ?? a.smiles, formula: mol?.formula, mw: mol?.mw, source: 'ChEMBL' },
            { ...cl, sourceDb: 'ChEMBL', sourceId: a.assayId, referenceUrl: a.documentId ? chembl.chemblDocUrl(a.documentId) : chembl.chemblUrl(a.moleculeId) });
        }
        sources.chembl = new Set([...mech.map((m) => m.moleculeId), ...act.map((a) => a.moleculeId)]).size;
      }
    } catch (e) {
      if ((e as Error).message === 'Cancelled') throw e;
      sources.chembl = 'unavailable';
      notes.push(`ChEMBL could not be reached (${(e as Error).message}); results below are without ChEMBL. Re-run later to add it.`);
    }
  }

  if (o.sources.includes('pdb')) {
    try {
      let n = 0;
      for (const p of (entry?.pdb ?? []).slice().sort((a, b) => (a.resolution ?? 99) - (b.resolution ?? 99)).slice(0, 6)) {
        for (const l of await pdbLigands(p.id, c.signal)) {
          if (isAdditive(l.compId) || isIon(l.compId) || (l.weight !== null && l.weight < 90)) continue; // crystallisation additives / ions are not ligands of interest
          add(map, { name: l.name, inchiKey: l.inchiKey, inchi: l.inchi, smiles: l.smiles, formula: l.formula, mw: l.weight, source: 'RCSB PDB' }, {
            relationType: 'co-crystallised ligand', evidenceClass: 'experimentally_verified', sourceDb: 'RCSB PDB', sourceId: `${p.id.toUpperCase()}:${l.compId}`, referenceUrl: pdbUrl(p.id),
            evidence: `${l.compId} (${l.name}) is present in ${p.method || 'experimental'} structure ${p.id.toUpperCase()}${p.resolution ? ` at ${p.resolution} Å` : ''}; observed in the structure, which does not by itself show function`,
          });
          n++;
        }
      }
      sources.pdb = n;
    } catch (e) {
      if ((e as Error).message === 'Cancelled') throw e;
      sources.pdb = 'unavailable';
      notes.push(`RCSB PDB ligand lookup failed (${(e as Error).message}).`);
    }
  }

  if (o.sources.includes('bindingdb')) {
    const rows = await affinitiesForUniprot(uniprot, { cutoffNm: 1000, signal: c.signal });
    if (rows === null) { sources.bindingdb = 'unavailable'; notes.push('BindingDB is unavailable right now; skipped.'); }
    else {
      const best = new Map<string, (typeof rows)[number]>();
      for (const r of rows.sort((a, b) => (a.value ?? 1e12) - (b.value ?? 1e12))) if (!best.has(r.monomerId)) best.set(r.monomerId, r);
      for (const r of [...best.values()].slice(0, 15)) {
        add(map, { name: null, inchiKey: r.inchiKey, smiles: r.smiles, source: 'BindingDB' }, {
          relationType: `ligand (measured ${r.type || 'affinity'})`, evidenceClass: 'experimentally_verified', sourceDb: 'BindingDB', sourceId: r.monomerId, referenceUrl: bindingdbUrl(r.monomerId),
          evidence: `${r.type || 'Affinity'} ${r.relation}${r.value ?? '?'} ${r.unit}${r.pmid ? `, PMID ${r.pmid}` : ''}${r.doi ? `, DOI ${r.doi}` : ''}`,
        });
      }
      sources.bindingdb = best.size;
    }
  }

  // rank: more independent sources, stronger evidence, then ChEMBL mechanisms first
  const rank = (l: LigandCandidate) => new Set(l.evidence.map((e) => e.sourceDb)).size * 10 + (l.evidence.some((e) => e.evidenceClass === 'database_annotated') ? 5 : 0) + (l.evidence.some((e) => e.evidenceClass === 'experimentally_verified') ? 3 : 0);
  return [...map.values()].sort((a, b) => rank(b) - rank(a)).slice(0, o.maxCompounds);
}

export async function discoverChemicals(c: Ctx, proteinRecordId: string, o: { sources?: string[]; maxCompounds?: number; minPchembl?: number; progress?: (d: number, t: number) => void } = {}): Promise<ChemicalDiscovery> {
  const protTable = getRaw(proteinRecordId)?.tableId;
  if (!protTable) throw new Fatal('Protein record not found');
  const accession = String(valueOf(protTable, proteinRecordId, 'accession') ?? '').trim();
  const uniprot = accession.replace(/-\d+$/, '').toUpperCase();
  if (!RE.uniprot.test(uniprot)) throw new Fatal(`Chemical discovery needs a UniProt accession; "${accession}" is not one.`);
  const chemTable = tableOfKind(c, 'chemical');
  const notes: string[] = [];
  const sources: ChemicalDiscovery['sources'] = {};
  if (accession.includes('-')) notes.push(`${accession} is an isoform – compound data is reported for the canonical protein ${uniprot}.`);
  const cands = await collectLigands(c, uniprot, { sources: o.sources ?? ['chembl', 'pdb', 'bindingdb'], maxCompounds: o.maxCompounds ?? 30, minPchembl: o.minPchembl ?? 6 }, notes, sources);
  const out: ChemicalDiscovery['chemicals'] = [];
  let i = 0;
  for (const cand of cands) {
    if (c.signal?.aborted) throw new Error('Cancelled');
    // BindingDB gives SMILES only: resolve an InChIKey through PubChem so de-duplication works across sources
    if (!cand.inchiKey && cand.smiles) {
      try { const cid = (await cidsBySmiles(cand.smiles, c.signal))[0]; if (cid) { const p = (await propsForCids([cid], c.signal))[0]; if (p) { cand.inchiKey = p.inchiKey; cand.name ??= p.title; cand.formula ??= p.formula; cand.mw ??= p.molecularWeight; cand.inchi ??= p.inchi; } } } catch { /* identity stays SMILES-based */ }
    }
    const display = cand.name || cand.chemblId || cand.inchiKey || cand.smiles?.slice(0, 40) || 'Unnamed compound';
    const r = upsertByKey(c, chemTable, cand.inchiKey ? 'inchikey' : cand.chemblId ? 'chembl' : 'smiles', (cand.inchiKey ?? cand.chemblId ?? cand.smiles)!, {
      name: display, inchikey: cand.inchiKey ?? undefined, chembl: cand.chemblId, formula: cand.formula, mw: cand.mw ?? undefined, smiles: cand.smiles, inchi: cand.inchi, source: cand.source,
    }, {
      sourceDb: [...new Set(cand.evidence.map((e) => e.sourceDb))].join(', '), accession: cand.chemblId ?? cand.inchiKey ?? null, query: `${uniprot} (protein→chemical)`, url: cand.evidence[0]?.referenceUrl ?? null, step: 'discovery',
      note: cand.evidence.slice(0, 2).map((e) => e.evidence).join(' | ').slice(0, 400),
    }, { alsoMatch: [['chembl', cand.chemblId ?? ''], ['inchikey', cand.inchiKey ?? '']] });
    const f = relationField(protTable, chemTable);
    if (f) for (const ev of cand.evidence) linkWithEvidence(f.id, proteinRecordId, r.id, ev);
    const top = cand.evidence.slice().sort((a, b) => (b.evidenceClass === 'experimentally_verified' ? 1 : 0) - (a.evidenceClass === 'experimentally_verified' ? 1 : 0))[0];
    out.push({ recordId: r.id, name: display, relationType: top.relationType ?? 'ligand', evidenceClass: top.evidenceClass, sources: [...new Set(cand.evidence.map((e) => e.sourceDb))].join(', ') });
    o.progress?.(++i, cands.length);
  }
  if (!out.length) notes.push('No compounds with documented target relationships were found. Nothing was inferred from literature co-occurrence.');
  flagDuplicates(chemTable);
  return { chemicals: out, notes, sources };
}

// ---------------- enrichment (PubChem) ----------------
export async function enrichChemical(c: Ctx, chemRecordId: string): Promise<{ cid: string | null; changed: boolean; note: string }> {
  const raw = getRaw(chemRecordId);
  if (!raw) throw new Fatal('Chemical record not found');
  const t = raw.tableId;
  const v = (k: string) => String(valueOf(t, chemRecordId, k) ?? '').trim();
  let cids: string[] = [];
  if (v('cid')) cids = [v('cid').replace(/\D/g, '')];
  else if (v('inchikey')) cids = await cidsByInchiKey(v('inchikey'), c.signal);
  if (!cids.length && v('smiles')) cids = await cidsBySmiles(v('smiles'), c.signal);
  if (!cids.length && v('name')) cids = await resolveChemical(v('name'), c.signal);
  if (!cids.length) { addProvenance(chemRecordId, { sourceDb: 'PubChem', query: v('name') || v('inchikey') || v('smiles'), step: 'metadata', note: 'No PubChem compound matched the identifiers on this record' }); return { cid: null, changed: false, note: 'No PubChem match' }; }
  const cid = cids[0];
  const [p] = await propsForCids([cid], c.signal);
  if (!p) return { cid, changed: false, note: 'PubChem returned no properties' };
  let bio = '';
  let nTargets = 0;
  try {
    const b = await bioactivity(cid, c.signal);
    if (b) { nTargets = b.targets.length; bio = `PubChem BioAssay: ${b.activeAssays} active outcome(s) in ${b.totalAssays} tested assay(s).${b.targets.length ? ' Targets with active outcomes: ' + b.targets.slice(0, 10).map((x) => `${x.accession || 'GeneID ' + x.geneId} (${x.activeCount})`).join(', ') + '.' : ''} (Assay outcomes, not curated mechanisms.)`; }
  } catch { /* optional */ }
  let syn: string[] = [];
  try { syn = await synonyms(cid, 5, c.signal); } catch { /* optional */ }
  const changed = fillRecord(c, t, chemRecordId, {
    name: v('name') ? undefined : p.title || syn[0], cid, inchikey: p.inchiKey, formula: p.formula, mw: p.molecularWeight ?? undefined, smiles: p.smiles, isoSmiles: p.isoSmiles, inchi: p.inchi, bioactivity: bio || undefined,
  }, { sourceDb: 'PubChem', accession: cid, query: v('inchikey') || v('name') || v('smiles'), url: pubchemUrl(cid), step: 'metadata', note: `${p.iupacName ? p.iupacName.slice(0, 160) : p.title}${syn.length ? '; synonyms: ' + syn.join(', ') : ''}` });
  flagDuplicates(t);
  return { cid, changed, note: `PubChem CID ${cid}${nTargets ? `, ${nTargets} bioassay target(s)` : ''}` };
}

// ---------------- duplicates ----------------
// Keep the "Possible duplicate" flags current when identifiers are edited by hand or by an import (debounced per table).
const dupTimers = new Map<string, NodeJS.Timeout>();
onRecordChange((e) => {
  if (e.type === 'deleted') return;
  const t = q.get<{ kind: string }>('SELECT kind FROM tables WHERE id=?', e.tableId);
  if (t?.kind !== 'chemical') return;
  const idFields = ['cid', 'chembl', 'inchikey'].map((k) => fieldByKey(e.tableId, k)?.id).filter(Boolean) as string[];
  if (e.type === 'updated' && !e.changed.some((c) => idFields.includes(c))) return;
  clearTimeout(dupTimers.get(e.tableId));
  const timer = setTimeout(() => { dupTimers.delete(e.tableId); try { flagDuplicates(e.tableId); } catch { /* table may have been deleted */ } }, 400);
  timer.unref();
  dupTimers.set(e.tableId, timer);
});
export interface DupGroup { reason: string; ids: string[]; names: string[] }

/** Group chemicals that share a CID, ChEMBL ID, full InChIKey, or the first (connectivity) block of the InChIKey. */
export function findDuplicateChemicals(tableId: string): DupGroup[] {
  const fk = (k: string) => fieldByKey(tableId, k)?.id;
  const keys = { cid: fk('cid'), chembl: fk('chembl'), ik: fk('inchikey'), name: fk('name') };
  const rows = q.all<{ id: string; data: string }>('SELECT id, data FROM records WHERE table_id=?', tableId).map((r) => ({ id: r.id, d: safeJson<Record<string, any>>(r.data, {}) }));
  const groups: DupGroup[] = [];
  const seenPairs = new Set<string>();
  const bucket = (name: string, f: (r: (typeof rows)[number]) => string | undefined) => {
    const m = new Map<string, typeof rows>();
    for (const r of rows) { const k = f(r); if (k) m.set(k, [...(m.get(k) ?? []), r]); }
    for (const [k, v] of m) {
      if (v.length < 2) continue;
      const sig = v.map((x) => x.id).sort().join();
      if (seenPairs.has(sig)) continue;
      seenPairs.add(sig);
      groups.push({ reason: `${name} ${k}`, ids: v.map((x) => x.id), names: v.map((x) => String(x.d[keys.name ?? ''] ?? x.id)) });
    }
  };
  bucket('PubChem CID', (r) => (keys.cid ? String(r.d[keys.cid] ?? '').trim() || undefined : undefined));
  bucket('ChEMBL ID', (r) => (keys.chembl ? String(r.d[keys.chembl] ?? '').trim().toUpperCase() || undefined : undefined));
  bucket('InChIKey', (r) => (keys.ik ? String(r.d[keys.ik] ?? '').trim().toUpperCase() || undefined : undefined));
  bucket('same structure skeleton (InChIKey connectivity block; may differ in stereochemistry or charge)', (r) => (keys.ik ? String(r.d[keys.ik] ?? '').slice(0, 14).toUpperCase() || undefined : undefined));
  return groups;
}

/** Tick the "Possible duplicate" checkbox on every record that appears in a duplicate group. */
export function flagDuplicates(tableId: string) {
  const f = fieldByKey(tableId, 'dupFlag');
  if (!f) return;
  const dup = new Set(findDuplicateChemicals(tableId).flatMap((g) => g.ids));
  tx(() => {
    for (const r of q.all<{ id: string; data: string }>('SELECT id, data FROM records WHERE table_id=?', tableId)) {
      const d = safeJson<Record<string, any>>(r.data, {});
      const want = dup.has(r.id);
      if ((d[f.id] === true) !== want) {
        if (want) d[f.id] = true; else delete d[f.id];
        q.run('UPDATE records SET data=? WHERE id=?', JSON.stringify(d), r.id);
      }
    }
  });
}

/** Merge duplicate chemicals into `keepId`: links are re-pointed (evidence preserved), empty fields filled, duplicates removed. */
export function mergeChemicals(tableId: string, keepId: string, dropIds: string[], userId: string | null): { merged: number; linksMoved: number } {
  let moved = 0;
  const fields = listFields(tableId);
  tx(() => {
    const keep = getRaw(keepId)!;
    const data = { ...keep.data };
    for (const dropId of dropIds) {
      if (dropId === keepId) continue;
      const drop = getRaw(dropId);
      if (!drop || drop.tableId !== tableId) continue;
      for (const [fid, val] of Object.entries(drop.data)) if (data[fid] === undefined || data[fid] === null || data[fid] === '') data[fid] = val;
      for (const rf of fields.filter((f) => f.type === 'relation')) {
        const inv = rf.options.inverseFieldId;
        for (const l of q.all<{ id: number; field_id: string; from_id: string; to_id: string; meta: string | null }>('SELECT * FROM links WHERE (field_id=? AND from_id=?) OR (field_id=? AND to_id=?)', rf.id, dropId, inv ?? '', dropId)) {
          const fromSide = l.field_id === rf.id;
          const other = fromSide ? l.to_id : l.from_id;
          const exists = q.get('SELECT id, meta FROM links WHERE (field_id=? AND from_id=? AND to_id=?) OR (field_id=? AND from_id=? AND to_id=?)', rf.id, keepId, other, inv ?? '', other, keepId) as any;
          if (exists) { // same relation already present on the kept record: merge evidence items
            const a = safeJson<any>(exists.meta, null), b = safeJson<any>(l.meta, null);
            if (b) q.run('UPDATE links SET meta=? WHERE id=?', JSON.stringify({ ...b, ...a, details: { items: [...(a?.details?.items ?? []), ...(b?.details?.items ?? [])].slice(0, 25) } }), exists.id);
            q.run('DELETE FROM links WHERE id=?', l.id);
          } else {
            if (fromSide) q.run('UPDATE links SET from_id=? WHERE id=?', keepId, l.id); else q.run('UPDATE links SET to_id=? WHERE id=?', keepId, l.id);
            moved++;
          }
        }
      }
      q.run('INSERT INTO provenance(id,record_id,source_db,accession,query,url,retrieved_at,step,note) SELECT id||?,?,source_db,accession,query,url,retrieved_at,step,note FROM provenance WHERE record_id=?', `_m${Date.now() % 1e6}`, keepId, dropId);
      addProvenance(keepId, { sourceDb: 'VierStation', step: 'merge', note: `Merged duplicate record ${dropId}` });
      q.run('DELETE FROM search WHERE rowid IN (SELECT rowid FROM records WHERE id=?)', dropId);
      q.run('DELETE FROM records WHERE id=?', dropId);
    }
    q.run('UPDATE records SET data=?, updated_at=?, updated_by=? WHERE id=?', JSON.stringify(data), now(), userId, keepId);
  });
  return { merged: dropIds.length, linksMoved: moved };
}
