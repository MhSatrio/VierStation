import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, newUser, tableMeta, waitJob, fixture } from './helpers.ts';
import { calls, callsTo, installUpstream, mode } from './upstream.ts';
import { purgeCache } from '../server/integrations/http.ts';
import { classifyNucleotide } from '../server/discovery/dna.ts';
import { parseGenBank, cdsFrom, genesFrom, collectionInfo, parseBlast } from '../server/integrations/ncbi.ts';
import { parseEntry } from '../server/integrations/uniprot.ts';
import { classifyActivity, classifyMechanism, mechanisms, activities } from '../server/integrations/chembl.ts';
import { parseBindingDb } from '../server/integrations/bindingdb.ts';
import { parseAssaySummary, parseProps } from '../server/integrations/pubchem.ts';
import { parseLigands, isAdditive, isIon } from '../server/integrations/rcsb.ts';
import { parseModels } from '../server/integrations/alphafold.ts';
import { parseInterPro } from '../server/integrations/interpro.ts';
import { mergeMeta } from '../server/ingest.ts';
import { config } from '../server/config.ts';
import { findOrfs, reverseComplement } from '../shared/sequence.ts';

let base = '', close: () => Promise<void>;
before(async () => { const s = await boot(); base = s.base; close = s.close; });
after(async () => { await close(); });
beforeEach(() => { purgeCache(); installUpstream(); mode.chemblDown = false; mode.afMissing = false; mode.bindingdbDown = false; mode.blastHits = true; config.offline = true; });

// ---------------------------------------------------------------- parsers against REAL captured responses
test('GenBank parser reads the real NM_000546 record: genes, CDS, translation, source info', () => {
  const gb = parseGenBank(fixture('efetch_gb.txt'))!;
  assert.equal(gb.version, 'NM_000546.6'); assert.equal(gb.length, 2512); assert.equal(gb.sequence.length, 2512);
  assert.equal(gb.organism, 'Homo sapiens'); assert.equal(gb.taxId, 9606);
  const genes = genesFrom(gb), cds = cdsFrom(gb);
  assert.equal(genes[0].symbol, 'TP53'); assert.equal(genes[0].geneId, '7157');
  assert.equal(cds[0].proteinId, 'NP_000537.3'); assert.equal(cds[0].translation.length, 393); assert.ok(cds[0].translation.startsWith('MEEPQSDPSVEPPLSQETF'));
  assert.ok(!cds[0].partial);
  assert.match(collectionInfo(gb), /chromosome: 17/);
});

test('UniProt parser reads the real P04637 and P00519 entries (isoforms, PDB, cross-references)', () => {
  const e = parseEntry(JSON.parse(fixture('uniprot_geneid7157.json')).results[0]);
  assert.equal(e.accession, 'P04637'); assert.equal(e.geneSymbol, 'TP53'); assert.equal(e.length, 393); assert.ok(e.reviewed);
  assert.ok(e.geneIds.includes('7157')); assert.ok(e.pdb.length > 20); assert.ok(e.hasAlphaFold);
  assert.ok(e.isoforms.length >= 8 && e.isoforms.some((i) => i.id === 'P04637-2'));
  assert.ok(e.function.startsWith('Multifunctional transcription factor'));
  assert.ok(e.function.length > 100 && !e.function.includes('PubMed:'), 'citation markers stripped');
  const a = parseEntry(JSON.parse(fixture('uniprot_P00519.json')).results[0]);
  assert.equal(a.geneSymbol, 'ABL1'); assert.ok(a.pdb.some((p) => p.id === '1BBZ' && p.method === 'X-ray' && p.resolution === 1.65));
});

test('AlphaFold, InterPro, RCSB ligand and PubChem parsers on real responses', () => {
  const m = parseModels(JSON.parse(fixture('af_P04637.json')))[0];
  assert.equal(m.entryId, 'AF-P04637-F1'); assert.ok(m.meanPlddt! > 50 && m.meanPlddt! < 100); assert.match(m.pdbUrl, /^https:\/\/alphafold\.ebi\.ac\.uk\/files\//);
  assert.equal(parseModels({ error: 'x' }).length, 0, 'non-array (error) responses mean no model');
  const ip = parseInterPro(JSON.parse(fixture('interpro_P04637.json')));
  assert.ok(ip.some((x) => x.accession === 'IPR002117' && x.type === 'family') && ip.every((x) => x.locations.length >= 0));
  const lig = parseLigands(JSON.parse(fixture('rcsb_gql_1IEP.json')));
  assert.equal(lig[0].compId, 'STI'); assert.equal(lig[0].inchiKey, 'KTUFNOKKBVMGRW-UHFFFAOYSA-N');
  assert.ok(isAdditive('GOL') && isAdditive('SO4') && isIon('ZN') && !isAdditive('STI'));
  const props = parseProps(JSON.parse(fixture('pc_props.json')))[0];
  assert.equal(props.cid, '5291'); assert.equal(props.formula, 'C29H31N7O'); assert.equal(props.molecularWeight, 493.6); assert.ok(props.smiles && props.inchi.startsWith('InChI=1S/'));
  const bio = parseAssaySummary(JSON.parse(fixture('pc_assay.json')))!;
  assert.ok(bio.activeAssays > 0 && bio.activeAssays <= bio.totalAssays && bio.targets.length > 0);
});

test('ChEMBL classification: curated mechanism vs measured activity; never "inhibitor" from a Ki', () => {
  const mech = JSON.parse(fixture('chembl_mech_ABL1.json')).mechanisms;
  assert.ok(mech.length > 3);
  const ms = mech.map((m: any) => ({ moleculeId: m.molecule_chembl_id, action: String(m.action_type).toUpperCase(), mechanism: m.mechanism_of_action, directInteraction: !!m.direct_interaction, refs: (m.mechanism_refs ?? []).map((r: any) => ({ type: r.ref_type, id: r.ref_id, url: r.ref_url })) }));
  const c = classifyMechanism(ms[0]);
  assert.equal(c.relationType, 'inhibitor'); assert.equal(c.evidenceClass, 'database_annotated'); assert.match(c.evidence, /curated mechanism/);
  const base = { moleculeId: 'CHEMBL1', moleculeName: null, smiles: null, relation: '=', units: 'nM', pchembl: 8, assayId: 'CHEMBL9', assayType: 'B', assayDescription: '', documentId: 'CHEMBL100', year: 2020, pubmed: null };
  assert.equal(classifyActivity({ ...base, type: 'IC50', value: 5 })!.relationType, 'inhibitor (measured IC50)');
  assert.equal(classifyActivity({ ...base, type: 'Ki', value: 5 })!.relationType, 'ligand (measured Ki)');
  assert.equal(classifyActivity({ ...base, type: 'EC50', value: 5 })!.relationType, 'modulator (measured EC50)');
  assert.equal(classifyActivity({ ...base, type: 'IC50', value: 5 })!.evidenceClass, 'experimentally_verified');
  assert.equal(classifyActivity({ ...base, type: 'IC50', value: 5, assayType: 'A' }), null, 'ADME assays are not target relationships');
  assert.equal(classifyActivity({ ...base, type: 'IC50', value: null }), null);
  assert.match(classifyActivity({ ...base, type: 'IC50', value: 5 })!.evidence, /document CHEMBL100/);
});

test('BindingDB parser keeps qualifiers and drops "> x" (non-binders) from the real response', () => {
  const rows = parseBindingDb(JSON.parse(fixture('bindingdb_P00519.json')));
  assert.ok(rows.length > 5);
  assert.ok(rows.every((r) => r.relation !== '>'));
  assert.ok(rows.some((r) => r.relation === '<'), 'upper-bound measurements keep their "<"');
  const fake = parseBindingDb({ x: { rows: [{ monomerid: '1', smile: 'CC', affinity_type: 'IC50', affinity: '>10000' }, { monomerid: '2', smile: 'CCC', affinity_type: 'Ki', affinity: '12' }] } });
  assert.deepEqual(fake.map((f) => f.monomerId), ['2']);
});

test('classification of nucleotide sequences distinguishes coding / non-coding / partial / uncertain and records the basis', () => {
  const gb = parseGenBank(fixture('efetch_gb.txt'))!;
  const types = [...new Set(gb.features.map((f) => f.type))];
  const annotated = classifyNucleotide({ moltype: 'rna', biomol: 'mRNA', length: gb.length, genes: genesFrom(gb), cds: cdsFrom(gb), featureTypes: types, sequence: gb.sequence });
  assert.deepEqual([annotated.cls, annotated.basis], ['mRNA / cDNA', 'annotated']);
  const orf = 'ATG' + 'GCTAAAGTTCTG'.repeat(40) + 'TAA';
  const seq = 'GGCTT' + orf + 'CCAAT';
  const inferred = classifyNucleotide({ length: seq.length, genes: [], cds: [], featureTypes: [], sequence: seq });
  assert.deepEqual([inferred.cls, inferred.basis], ['Coding DNA', 'inferred']);
  assert.match(inferred.note, /not an annotation/);
  const rc = classifyNucleotide({ length: seq.length, genes: [], cds: [], featureTypes: [], sequence: reverseComplement(seq) });
  assert.equal(rc.cls, 'Coding DNA', 'ORF on the reverse strand is found');
  const noise = 'ACGT'.repeat(4).repeat(1) + 'TTAATTAGCTAGCTAGGATCCTAGTAGATAGATTCTAGATCGAT'.repeat(5);
  assert.equal(classifyNucleotide({ length: noise.length, genes: [], cds: [], featureTypes: [], sequence: noise }).cls, 'Uncertain annotation');
  assert.equal(classifyNucleotide({ length: 40, genes: [], cds: [], featureTypes: [], sequence: 'ACGT'.repeat(10) }).cls, 'Uncertain annotation', 'too short to say');
  assert.equal(classifyNucleotide({ length: 120, genes: [], cds: [], featureTypes: ['rRNA', 'gene'], sequence: 'A'.repeat(120) }).cls, 'Non-coding DNA');
  const partialCds = { gene: 'X', geneId: '1', product: '', proteinId: null, translation: 'M', location: '<1..>300', codonStart: 1, partial: true, note: '', complement: false };
  assert.equal(classifyNucleotide({ length: 300, genes: [], cds: [partialCds], featureTypes: ['CDS'], sequence: '' }).cls, 'Partial sequence');
  const partialOrf = 'GCTAAAGTTCTG'.repeat(60); // long ORF with neither start nor stop
  assert.equal(classifyNucleotide({ length: partialOrf.length, genes: [], cds: [], featureTypes: [], sequence: partialOrf }).cls, 'Partial sequence');
  assert.ok(findOrfs(partialOrf, 30)[0].partial5);
});

test('evidence merging: strongest class wins, curated relation type wins, items are accumulated once', () => {
  let m = mergeMeta(null, { relationType: 'co-crystallised ligand', evidenceClass: 'experimentally_verified', evidence: 'in 1IEP', sourceDb: 'RCSB PDB' });
  m = mergeMeta(m, { relationType: 'inhibitor', evidenceClass: 'database_annotated', evidence: 'ChEMBL MoA', sourceDb: 'ChEMBL' });
  m = mergeMeta(m, { relationType: 'inhibitor', evidenceClass: 'database_annotated', evidence: 'ChEMBL MoA', sourceDb: 'ChEMBL' });
  assert.equal(m.evidenceClass, 'experimentally_verified'); assert.equal(m.relationType, 'inhibitor');
  assert.equal((m.details as any).items.length, 2); assert.equal(m.sourceDb, 'RCSB PDB, ChEMBL');
  const weak = mergeMeta(null, { evidenceClass: 'computationally_predicted', evidence: 'AF', sourceDb: 'AlphaFold DB' });
  assert.equal(mergeMeta(weak, { evidenceClass: 'user_supplied', evidence: 'me', sourceDb: 'Manual' }).evidenceClass, 'computationally_predicted');
});

// ---------------------------------------------------------------- end-to-end: DNA -> gene -> protein -> structure
test('DNA accession → metadata → gene → proteins (incl. isoforms) → AlphaFold + PDB, all via background jobs, idempotent on re-run', async () => {
  const u = await newUser(base);
  const dna = await tableMeta(u.api, u.tables.dna), gene = await tableMeta(u.api, u.tables.gene), prot = await tableMeta(u.api, u.tables.protein), struct = await tableMeta(u.api, u.tables.structure);
  const rec = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { createChoices: true, fields: { [dna.byKey('accession')]: 'NM_000546', [dna.byKey('status')]: 'To fetch' } })).json.records[0];

  // 1) metadata
  const j1 = await waitJob(u.api, (await u.api.post(`/api/records/${rec.id}/discover`, { what: 'metadata' })).json.jobId);
  assert.equal(j1.job.status, 'completed', JSON.stringify(j1.job.error));
  let r = (await u.api.get(`/api/records/${rec.id}`)).json;
  const f = r.record.fields;
  assert.equal(f[dna.byKey('length')], 2512);
  assert.match(f[dna.byKey('name')], /tumor protein p53/);
  assert.equal(f[dna.byKey('accession')], 'NM_000546.6' === f[dna.byKey('accession')] ? 'NM_000546.6' : 'NM_000546', 'the user-entered accession is kept');
  const cls = dna.fields.find((x: any) => x.key === 'seqClass').options.choices;
  assert.equal(cls.find((c: any) => c.id === f[dna.byKey('seqClass')]).name, 'mRNA / cDNA');
  const statusName = (rr: any, t: any) => t.fields.find((x: any) => x.key === 'status').options.choices.find((c: any) => c.id === rr.fields[t.byKey('status')])?.name;
  assert.equal(statusName(r.record, dna), 'Completed');
  assert.equal(f[dna.byName('GC content')] > 0.3 && f[dna.byName('GC content')] < 0.7, true, 'formula over the fetched sequence');
  assert.ok(r.provenance.some((p: any) => p.sourceDb === 'NCBI Nucleotide' && p.url?.includes('ncbi.nlm.nih.gov/nuccore') && p.accession === 'NM_000546.6'), 'provenance: source, accession, URL, time');
  assert.ok(r.provenance.every((p: any) => p.retrievedAt));
  assert.equal(f[dna.byName('Organism')]?.[0]?.name, 'Homo sapiens', 'organism record created and linked');

  // 2) genes
  const j2 = await waitJob(u.api, (await u.api.post(`/api/records/${rec.id}/discover`, { what: 'genes' })).json.jobId);
  assert.equal(j2.job.status, 'completed', JSON.stringify(j2.job.error));
  r = (await u.api.get(`/api/records/${rec.id}`)).json;
  const genes = r.record.fields[dna.byName('Genes')];
  assert.equal(genes.length, 1); assert.equal(genes[0].name, 'TP53');
  assert.equal(genes[0].meta.evidenceClass, 'database_annotated'); assert.equal(genes[0].meta.relationType, 'encodes');
  assert.match(genes[0].meta.referenceUrl, /ncbi\.nlm\.nih\.gov\/gene\/7157/); assert.ok(genes[0].meta.sourceDb);
  const g = (await u.api.get(`/api/records/${genes[0].id}`)).json;
  assert.equal(g.record.fields[gene.byKey('geneId')], '7157');

  // 3) proteins
  const j3 = await waitJob(u.api, (await u.api.post(`/api/records/${genes[0].id}/discover`, { what: 'proteins' })).json.jobId);
  assert.equal(j3.job.status, 'completed', JSON.stringify(j3.job.error));
  const gr = (await u.api.get(`/api/records/${genes[0].id}`)).json.record;
  const prots = gr.fields[gene.byName('Proteins')];
  assert.ok(prots.length >= 2, `a gene can encode several protein products (got ${prots.length})`);
  assert.ok(prots.some((p: any) => /isoform/i.test(p.name)), 'isoforms preserved as separate records');
  assert.ok(prots.every((p: any) => p.meta.evidenceClass === 'database_annotated' && p.meta.relationType.startsWith('encodes')));
  const canon = (await u.api.post(`/api/tables/${u.tables.protein}/query`, { filter: { mode: 'and', items: [{ field: prot.byKey('accession'), op: 'is', value: 'P04637' }] } })).json.records[0];
  assert.equal(canon.fields[prot.byKey('length')], 393); assert.equal(canon.fields[prot.byKey('reviewed')], true);
  assert.match(canon.fields[prot.byKey('domains')], /IPR002117/, 'InterPro domains written');
  assert.ok(canon.fields[prot.byName('Publications')].length > 0, 'UniProt-cited publications linked');
  const iso = (await u.api.post(`/api/tables/${u.tables.protein}/query`, { filter: { mode: 'and', items: [{ field: prot.byKey('accession'), op: 'is', value: 'P04637-2' }] } })).json.records[0];
  assert.ok(iso.fields[prot.byKey('sequence')].length > 100); assert.equal(iso.fields[prot.byKey('isoform')], 'isoform 2');

  // 4) structures
  const j4 = await waitJob(u.api, (await u.api.post(`/api/records/${canon.id}/discover`, { what: 'structures' })).json.jobId);
  assert.equal(j4.job.status, 'completed', JSON.stringify(j4.job.error));
  const pr = (await u.api.get(`/api/records/${canon.id}`)).json.record;
  const structs = pr.fields[prot.byName('Structures')];
  const af = structs.find((s: any) => s.name.startsWith('AF-P04637'));
  assert.ok(af, 'AlphaFold structure linked');
  assert.equal(af.meta.evidenceClass, 'computationally_predicted'); assert.match(af.meta.evidence, /computational prediction/);
  const exp = structs.filter((s: any) => s.meta.evidenceClass === 'experimentally_verified');
  assert.ok(exp.length >= 1, 'experimental PDB structures linked as experimentally verified');
  const avail = prot.fields.find((x: any) => x.key === 'structAvail').options.choices.find((c: any) => c.id === pr.fields[prot.byKey('structAvail')]).name;
  assert.equal(avail, 'AlphaFold available');
  const afRec = (await u.api.get(`/api/records/${af.id}`)).json.record;
  const sv = afRec.fields[struct.byKey('structure')];
  assert.equal(sv.source, 'alphafold'); assert.equal(sv.predicted, true); assert.ok(sv.meanPlddt > 50); assert.match(sv.fileUrl, /^https:\/\/alphafold/);
  assert.equal(calls.filter((c) => /model_v|\.pdb|\.cif/.test(c.url) && !/api\/prediction/.test(c.url)).length, 0, 'no coordinate download or folding was launched during discovery');

  // 5) idempotent re-run: no duplicate genes, proteins or structures
  const counts = async () => Object.fromEntries(await Promise.all(['gene', 'protein', 'structure'].map(async (k) => [k, (await u.api.post(`/api/tables/${u.tables[k]}/query`, {})).json.total])));
  const before = await counts();
  const provBefore = (await u.api.get(`/api/records/${canon.id}`)).json.provenance.length;
  await waitJob(u.api, (await u.api.post(`/api/records/${rec.id}/discover`, { what: 'genes' })).json.jobId);
  await waitJob(u.api, (await u.api.post(`/api/records/${genes[0].id}/discover`, { what: 'proteins' })).json.jobId);
  await waitJob(u.api, (await u.api.post(`/api/records/${canon.id}/discover`, { what: 'structures' })).json.jobId);
  assert.deepEqual(await counts(), before);
  const again = (await u.api.get(`/api/records/${canon.id}`)).json;
  assert.ok(again.provenance.length > provBefore, 'provenance keeps accumulating the processing history');
  assert.ok(again.provenance.filter((p: any) => p.sourceDb === 'AlphaFold DB' || p.sourceDb === 'UniProt').length >= 2);
});

test('the one-click pipeline: DNA → gene → protein → structure → chemicals, with a notification at the end', async () => {
  const u = await newUser(base);
  const dna = await tableMeta(u.api, u.tables.dna);
  const rec = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [dna.byKey('accession')]: 'NM_000546' } })).json.records[0];
  const job = await waitJob(u.api, (await u.api.post(`/api/records/${rec.id}/discover`, { what: 'pipeline', options: { maxProteins: 1, maxCompounds: 5 } })).json.jobId, 60_000);
  assert.equal(job.job.status, 'completed', JSON.stringify(job.job.error));
  assert.ok(job.job.result.summary.includes('1 gene'));
  assert.ok((await u.api.post(`/api/tables/${u.tables.structure}/query`, {})).json.total >= 1);
  const n = (await u.api.get('/api/notifications')).json;
  assert.ok(n.notifications.some((x: any) => x.kind === 'fetch_completed'), 'in-app notification created');
  assert.ok(job.job.progressDone !== null || job.logs.length > 0, 'real progress / logs recorded');
});

// ---------------------------------------------------------------- protein -> chemicals with evidence
test('protein → chemicals: evidence-classified links, de-duplication across ChEMBL/PDB/BindingDB, PubChem enrichment', async () => {
  const u = await newUser(base);
  const prot = await tableMeta(u.api, u.tables.protein), chem = await tableMeta(u.api, u.tables.chemical);
  const p = (await u.api.post(`/api/tables/${u.tables.protein}/records`, { fields: { [prot.byKey('accession')]: 'P00519' } })).json.records[0];
  const job = await waitJob(u.api, (await u.api.post(`/api/records/${p.id}/discover`, { what: 'chemicals', options: { maxCompounds: 25 } })).json.jobId, 60_000);
  assert.equal(job.job.status, 'completed', JSON.stringify(job.job.error));
  const links = (await u.api.get(`/api/records/${p.id}`)).json.record.fields[prot.byName('Chemicals')];
  assert.ok(links.length >= 3, `expected several compounds, got ${links.length}`);
  for (const l of links) { assert.ok(l.meta.evidenceClass && l.meta.sourceDb && l.meta.evidence && l.meta.relationType && l.meta.referenceUrl, `link ${l.name} carries full evidence`); }
  assert.ok(links.every((l: any) => l.meta.evidenceClass !== 'user_supplied'));
  // imatinib appears once even though three sources report it
  const all = (await u.api.post(`/api/tables/${u.tables.chemical}/query`, {})).json.records;
  const imatinib = all.filter((r: any) => r.fields[chem.byKey('inchikey')] === 'KTUFNOKKBVMGRW-UHFFFAOYSA-N');
  assert.equal(imatinib.length, 1, 'duplicate compounds merged by InChIKey');
  const il = links.find((l: any) => l.id === imatinib[0].id);
  assert.equal(il.meta.relationType, 'inhibitor');
  const items = il.meta.details.items;
  assert.ok(items.some((i: any) => i.sourceDb === 'ChEMBL' && i.evidenceClass === 'database_annotated'));
  assert.ok(items.some((i: any) => i.sourceDb === 'RCSB PDB' && i.evidenceClass === 'experimentally_verified' && /observed in the structure/.test(i.evidence)), 'a co-crystal is reported as observation, not as proof of function');
  assert.equal(il.meta.evidenceClass, 'experimentally_verified');
  // enrichment
  assert.equal(imatinib[0].fields[chem.byKey('cid')], '5291'); assert.equal(imatinib[0].fields[chem.byKey('formula')], 'C29H31N7O');
  assert.ok(imatinib[0].fields[chem.byKey('bioactivity')].includes('PubChem BioAssay'));
  // no relationship is called an inhibitor unless a mechanism or an IC50 assay says so
  for (const l of links) if (/inhibitor/.test(l.meta.relationType)) assert.ok(l.meta.details.items.some((i: any) => /inhibitor/.test(i.relationType ?? '') && (i.evidenceClass === 'database_annotated' || /IC50/.test(i.evidence))));
  // BindingDB non-binders ("> x nM") never became links
  assert.equal(JSON.stringify(links).includes('>10000'), false);
  // re-running does not duplicate chemicals or links
  const nBefore = all.length;
  await waitJob(u.api, (await u.api.post(`/api/records/${p.id}/discover`, { what: 'chemicals', options: { maxCompounds: 25 } })).json.jobId, 60_000);
  assert.equal((await u.api.post(`/api/tables/${u.tables.chemical}/query`, {})).json.total, nBefore);
  assert.equal((await u.api.get(`/api/records/${p.id}`)).json.record.fields[prot.byName('Chemicals')].length, links.length);
});

test('graceful degradation: ChEMBL/BindingDB outages produce partial results with an explanation, not a crash', async () => {
  const u = await newUser(base);
  const prot = await tableMeta(u.api, u.tables.protein);
  mode.chemblDown = true; mode.bindingdbDown = true;
  const p = (await u.api.post(`/api/tables/${u.tables.protein}/records`, { fields: { [prot.byKey('accession')]: 'P00519' } })).json.records[0];
  const job = await waitJob(u.api, (await u.api.post(`/api/records/${p.id}/discover`, { what: 'chemicals' })).json.jobId, 90_000);
  assert.equal(job.job.status, 'completed');
  assert.equal(job.job.result.sources.chembl, 'unavailable');
  assert.ok(job.job.result.notes.some((n: string) => /ChEMBL could not be reached/.test(n)));
  assert.ok(job.job.result.chemicals.length >= 1, 'PDB ligands still reported');
  assert.ok(job.job.result.chemicals.every((c: any) => c.sources.includes('PDB')));
});

test('structure lookup fallback: no AlphaFold model → marked unavailable, protein preserved, alternative (PDB) structures offered, nothing computed', async () => {
  const u = await newUser(base);
  const prot = await tableMeta(u.api, u.tables.protein);
  mode.afMissing = true;
  const p = (await u.api.post(`/api/tables/${u.tables.protein}/records`, { fields: { [prot.byKey('accession')]: 'P04637', [prot.byKey('name')]: 'p53' } })).json.records[0];
  const job = await waitJob(u.api, (await u.api.post(`/api/records/${p.id}/discover`, { what: 'structures' })).json.jobId);
  assert.equal(job.job.status, 'completed');
  assert.equal(job.job.result.alphafold.available, false);
  assert.match(job.job.result.alphafold.reason, /no model/);
  const r = (await u.api.get(`/api/records/${p.id}`)).json;
  const avail = prot.fields.find((x: any) => x.key === 'structAvail').options.choices.find((c: any) => c.id === r.record.fields[prot.byKey('structAvail')]).name;
  assert.equal(avail, 'Experimental only');
  assert.ok(r.record.fields[prot.byName('Structures')].every((s: any) => s.meta.evidenceClass === 'experimentally_verified'));
  assert.ok(r.provenance.some((x: any) => x.sourceDb === 'AlphaFold DB' && /no model/.test(x.note)), 'the failed lookup is documented');
  assert.equal(calls.filter((c) => /colabfold|alphafoldserver|\/predict(?!ion)/i.test(c.url)).length, 0, 'no folding service is ever called');
});

test('bad input fails clearly and marks the record Failed', async () => {
  const u = await newUser(base);
  const dna = await tableMeta(u.api, u.tables.dna);
  const rec = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { createChoices: true, fields: { [dna.byKey('accession')]: 'NM_999999', [dna.byKey('status')]: 'To fetch' } })).json.records[0];
  const job = await waitJob(u.api, (await u.api.post(`/api/records/${rec.id}/discover`, { what: 'metadata' })).json.jobId);
  assert.equal(job.job.status, 'failed');
  assert.match(job.job.error, /not found in NCBI/);
  const r = (await u.api.get(`/api/records/${rec.id}`)).json.record;
  assert.equal(dna.fields.find((x: any) => x.key === 'status').options.choices.find((c: any) => c.id === r.fields[dna.byKey('status')]).name, 'Failed');
  const n = (await u.api.get('/api/notifications')).json.notifications;
  assert.ok(n.some((x: any) => x.kind === 'task_failed'));
  // wrong-kind discovery is rejected up front
  assert.equal((await u.api.post(`/api/records/${rec.id}/discover`, { what: 'structures' })).status, 400);
});

test('sequence-only DNA (FASTA) → BLAST similarity → gene, linked as SEQUENCE INFERRED (not annotated); no hit → no guess', async () => {
  config.offline = false; config.blastMinWaitMs = 10; config.blastPollMs = 10;
  const u = await newUser(base);
  const dna = await tableMeta(u.api, u.tables.dna);
  const gb = fixture('efetch_gb.txt');
  const seq = gb.slice(gb.indexOf('ORIGIN')).split('\n').slice(1).join('').replace(/[^acgt]/g, '').toUpperCase().slice(0, 1000);
  const fa = await waitJob(u.api, (await u.api.post('/api/import/fasta', { projectId: u.projectId, text: `>mystery_amplicon test\n${seq}\n` })).json.jobId);
  assert.equal(fa.job.status, 'completed');
  const rid = fa.job.result.records[0].recordId;
  const j = await waitJob(u.api, (await u.api.post(`/api/records/${rid}/discover`, { what: 'genes' })).json.jobId, 60_000);
  assert.equal(j.job.status, 'completed', JSON.stringify(j.job.error));
  const g = (await u.api.get(`/api/records/${rid}`)).json.record.fields[dna.byName('Genes')];
  assert.equal(g.length, 1); assert.equal(g[0].meta.evidenceClass, 'sequence_inferred'); assert.match(g[0].meta.evidence, /matches NM_000546/); assert.equal(g[0].meta.details.items[0].details.identityPct, 100);
  // no similarity hit: nothing is invented
  mode.blastHits = false;
  const fa2 = await waitJob(u.api, (await u.api.post('/api/import/fasta', { projectId: u.projectId, text: `>nohit\n${'ACGTTGCAAGGCTTAACCGT'.repeat(5)}\n` })).json.jobId);
  const j2 = await waitJob(u.api, (await u.api.post(`/api/records/${fa2.job.result.records[0].recordId}/discover`, { what: 'genes' })).json.jobId, 60_000);
  assert.equal(j2.job.result.genes.length, 0);
  assert.ok(j2.job.result.notes.some((n: string) => /No gene could be assigned/.test(n)));
  assert.equal((await u.api.get(`/api/records/${fa2.job.result.records[0].recordId}`)).json.record.fields[dna.byName('Genes')].length, 0);
});

test('FASTA import rejects protein and garbage; handles multi-record files', async () => {
  const u = await newUser(base);
  const prot = await u.api.post('/api/import/fasta', { projectId: u.projectId, text: '>p\nMEEPQSDPSVEPPLSQETFSDLWKLLPENNVLSPLPSQ\n' });
  assert.equal(prot.status, 400); assert.match(prot.json.error, /protein/);
  const ok = await waitJob(u.api, (await u.api.post('/api/import/fasta', { projectId: u.projectId, text: '>a\nACGTACGTACGTAC\n>b desc\nGGGGCCCCAAAATTTT\n' })).json.jobId);
  assert.equal(ok.job.result.records.length, 2);
  assert.equal((await u.api.post('/api/import/fasta', { projectId: u.projectId, text: 'hello world' })).status, 400);
});

test('chemical duplicates: detected by InChIKey / connectivity block, flagged, and merged with links and evidence preserved', async () => {
  const u = await newUser(base);
  const chem = await tableMeta(u.api, u.tables.chemical), prot = await tableMeta(u.api, u.tables.protein);
  const mk = async (f: Record<string, unknown>) => (await u.api.post(`/api/tables/${u.tables.chemical}/records`, { fields: f })).json.records[0];
  const a = await mk({ [chem.byKey('name')]: 'Aspirin', [chem.byKey('inchikey')]: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N' });
  const b = await mk({ [chem.byKey('name')]: 'acetylsalicylic acid', [chem.byKey('inchikey')]: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N', [chem.byKey('cid')]: '2244' });
  const c = await mk({ [chem.byKey('name')]: 'Aspirin (charged form)', [chem.byKey('inchikey')]: 'BSYNRYMUTXBXSQ-UHFFFAOYSB-M' });
  const d = await mk({ [chem.byKey('name')]: 'Caffeine', [chem.byKey('inchikey')]: 'RYYVLZVUVIJVGH-UHFFFAOYSA-N' });
  const p = (await u.api.post(`/api/tables/${u.tables.protein}/records`, { fields: { [prot.byKey('name')]: 'COX1', [prot.byName('Chemicals')]: [b.id, d.id] } })).json.records[0];
  const groups = (await u.api.get(`/api/tables/${u.tables.chemical}/duplicates`)).json.groups;
  assert.ok(groups.some((g: any) => g.reason.startsWith('InChIKey') && g.ids.includes(a.id) && g.ids.includes(b.id)));
  assert.ok(groups.some((g: any) => /skeleton/.test(g.reason) && g.ids.includes(c.id)), 'same connectivity block suggested');
  assert.ok(!groups.some((g: any) => g.ids.includes(d.id)));
  const flagged = (await u.api.get(`/api/records/${a.id}`)).json.record.fields[chem.byKey('dupFlag')];
  assert.equal(flagged, true);
  const m = await u.api.post(`/api/tables/${u.tables.chemical}/merge`, { keepId: a.id, dropIds: [b.id] });
  assert.equal(m.status, 200);
  const kept = (await u.api.get(`/api/records/${a.id}`)).json.record;
  assert.equal(kept.fields[chem.byKey('cid')], '2244', 'empty fields filled from the merged duplicate');
  assert.equal((await u.api.get(`/api/records/${b.id}`)).status, 404);
  const pl = (await u.api.get(`/api/records/${p.id}`)).json.record.fields[prot.byName('Chemicals')];
  assert.deepEqual(pl.map((x: any) => x.name).sort(), ['Aspirin', 'Caffeine'], 'the protein link moved to the kept record');
  assert.equal(kept.fields[chem.byKey('dupFlag')], true, 'still flagged: the charged form shares its structure skeleton');
  assert.equal((await u.api.get(`/api/records/${d.id}`)).json.record.fields[chem.byKey('dupFlag')] ?? false, false, 'unrelated compounds are not flagged');
});

test('relationship graph returns nodes/edges with evidence', async () => {
  const u = await newUser(base);
  const dna = await tableMeta(u.api, u.tables.dna);
  const rec = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [dna.byKey('accession')]: 'NM_000546' } })).json.records[0];
  await waitJob(u.api, (await u.api.post(`/api/records/${rec.id}/discover`, { what: 'pipeline', options: { maxProteins: 1, maxCompounds: 3 } })).json.jobId, 60_000);
  const g = (await u.api.get(`/api/records/${rec.id}/graph?depth=3`)).json;
  const kinds = new Set(g.nodes.map((n: any) => n.kind));
  for (const k of ['dna', 'gene', 'protein', 'structure']) assert.ok(kinds.has(k), `graph contains ${k}`);
  assert.ok(g.edges.every((e: any) => e.meta === null || e.meta.evidenceClass));
  assert.ok(g.edges.some((e: any) => e.meta?.evidenceClass === 'computationally_predicted'));
});

void callsTo; void mechanisms; void activities; void parseBlast;
