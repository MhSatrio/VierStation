// Job handlers: every long-running scientific operation runs through the durable queue (never in a request).
import { Cancelled, Fatal, registerJob, onJobFinished } from '../jobs.ts';
import type { JobCtx } from '../jobs.ts';
import type { Ctx } from '../ingest.ts';
import { setStatus, tableOfKind, upsertByKey, valueOf } from '../ingest.ts';
import { getRaw } from '../records.ts';
import { importFasta, importNucleotide, importRegion, discoverGenes, applyClassification } from './dna.ts';
import { discoverProteins, enrichDomains, importGeneById, importProteinByAccession } from './protein.ts';
import { discoverStructures } from './structure.ts';
import { discoverChemicals, enrichChemical } from './chemical.ts';
import { pdbEntry, pdbFileUrl, pdbUrl } from '../integrations/rcsb.ts';
import { resolveChemical, propsForCids, pubchemUrl } from '../integrations/pubchem.ts';
import { RE } from '../../shared/sequence.ts';
import { now } from '../util.ts';
import { q } from '../db.ts';

export function toCtx(j: JobCtx): Ctx {
  return {
    workspaceId: j.workspaceId, projectId: j.projectId, userId: j.userId, signal: j.signal, log: j.log,
    origin: { jobId: j.id, automationId: j.automationId ?? undefined, depth: j.depth + 1 },
  };
}
const guard = (j: JobCtx) => { if (j.signal.aborted) throw new Cancelled(); };
const tableOf = (id: string) => getRaw(id)?.tableId;

/** Mark a record Processing while a job works on it. */
function processing(c: Ctx, recordId: string) {
  const t = tableOf(recordId);
  if (t) setStatus(t, recordId, 'Processing', c);
}
function done(c: Ctx, recordId: string, review = false) {
  const t = tableOf(recordId);
  if (t) setStatus(t, recordId, review ? 'Review' : 'Completed', c);
}

registerJob('fetch.nucleotide', async (j) => {
  const c = toCtx(j);
  const { recordId, accession, region } = j.payload as { recordId?: string; accession?: string; region?: string };
  if (recordId) processing(c, recordId);
  const input = (accession ?? (recordId ? String(valueOf(tableOf(recordId)!, recordId, 'accession') ?? '') : '')).trim();
  if (!input) throw new Fatal('Enter an accession or genomic coordinates first.');
  const r = region || RE.coords.test(input) ? await importRegion(c, input, { recordId }) : await importNucleotide(c, input, { recordId });
  const review = r.classification.basis === 'none';
  done(c, r.recordId, review);
  return {
    recordId: r.recordId, accession: r.accession, classification: r.classification, summary: `Fetched ${r.accession}: ${r.classification.cls}`,
    _notify: { kind: 'fetch_completed', title: `Fetched ${r.accession}`, body: `${r.classification.cls}. ${r.classification.note}`, link: `/record/${r.recordId}` },
  };
});

registerJob('import.fasta', async (j) => {
  const c = toCtx(j);
  const recs = importFasta(c, String(j.payload.text ?? ''));
  return { records: recs, summary: `Imported ${recs.length} sequence(s)`, _notify: { kind: 'fetch_completed', title: `Imported ${recs.length} FASTA sequence(s)`, link: recs[0] ? `/record/${recs[0].recordId}` : undefined } };
});

registerJob('discover.genes', async (j) => {
  const c = toCtx(j);
  const { recordId } = j.payload as { recordId: string };
  processing(c, recordId);
  const r = await discoverGenes(c, recordId, { progress: (m) => j.progress(0, null, m) });
  applyClassification(c, recordId, r.classification, 'VierStation sequence classification');
  done(c, recordId, !r.genes.length);
  return {
    genes: r.genes, classification: r.classification, notes: r.notes, blast: r.blast, summary: r.genes.length ? `Linked ${r.genes.length} gene(s)` : 'No gene could be assigned',
    _notify: { kind: 'fetch_completed', title: r.genes.length ? `Found ${r.genes.length} gene(s)` : 'No gene assigned', body: r.notes.join(' ').slice(0, 300), link: `/record/${recordId}` },
  };
}, { maxAttempts: 2 });

registerJob('discover.proteins', async (j) => {
  const c = toCtx(j);
  const { recordId } = j.payload as { recordId: string };
  processing(c, recordId);
  const r = await discoverProteins(c, recordId, { progress: (d, t) => j.progress(d, t) });
  done(c, recordId, !r.proteins.length);
  return { ...r, summary: `Linked ${r.proteins.length} protein record(s)`, _notify: { kind: 'fetch_completed', title: `Found ${r.proteins.length} protein(s)`, body: r.notes.join(' ').slice(0, 300), link: `/record/${recordId}` } };
});

registerJob('discover.structures', async (j) => {
  const c = toCtx(j);
  const { recordId } = j.payload as { recordId: string };
  processing(c, recordId);
  const r = await discoverStructures(c, recordId);
  done(c, recordId);
  const title = r.alphafold.available ? `AlphaFold structure ready (${r.uniprot})` : r.experimental.length ? `Experimental structure(s) found (${r.uniprot})` : `No structure available (${r.uniprot})`;
  return { ...r, summary: title, _notify: { kind: 'structure_ready', title, body: r.notes.join(' ').slice(0, 300), link: `/record/${recordId}` } };
});

registerJob('discover.chemicals', async (j) => {
  const c = toCtx(j);
  const p = j.payload as { recordId: string; sources?: string[]; maxCompounds?: number; enrich?: boolean };
  processing(c, p.recordId);
  const r = await discoverChemicals(c, p.recordId, { sources: p.sources, maxCompounds: p.maxCompounds, progress: (d, t) => j.progress(d, t, 'Linking compounds') });
  let enriched = 0;
  if (p.enrich !== false) {
    let i = 0;
    for (const ch of r.chemicals) {
      guard(j);
      j.progress(i++, r.chemicals.length, 'Fetching PubChem metadata');
      try { if ((await enrichChemical(c, ch.recordId)).cid) enriched++; } catch (e) { if (e instanceof Cancelled || (e as Error).message === 'Cancelled') throw e; r.notes.push(`PubChem enrichment failed for ${ch.name}: ${(e as Error).message}`); break; }
    }
  }
  done(c, p.recordId, !r.chemicals.length);
  return { ...r, enriched, summary: `Linked ${r.chemicals.length} compound(s)`, _notify: { kind: 'fetch_completed', title: `Found ${r.chemicals.length} compound(s)`, body: r.notes.join(' ').slice(0, 300), link: `/record/${p.recordId}` } };
});

registerJob('enrich.chemical', async (j) => {
  const c = toCtx(j);
  const { recordId } = j.payload as { recordId: string };
  processing(c, recordId);
  const r = await enrichChemical(c, recordId);
  done(c, recordId, !r.cid);
  return { ...r, summary: r.note, _notify: { kind: 'fetch_completed', title: r.cid ? `PubChem CID ${r.cid} retrieved` : 'No PubChem match', body: r.note, link: `/record/${recordId}` } };
});

registerJob('enrich.protein', async (j) => {
  const c = toCtx(j);
  const { recordId } = j.payload as { recordId: string };
  processing(c, recordId);
  const t = tableOf(recordId)!;
  const acc = String(valueOf(t, recordId, 'accession') ?? '').trim();
  if (!acc) throw new Fatal('Add a UniProt accession first.');
  const p = await importProteinByAccession(c, acc, { recordId });
  await enrichDomains(c, recordId).catch((e) => j.log(`InterPro: ${e.message}`, 'warn'));
  done(c, recordId);
  return { accession: p.accession, summary: `Retrieved ${p.name}`, _notify: { kind: 'fetch_completed', title: `Retrieved ${p.name}`, link: `/record/${recordId}` } };
});

registerJob('enrich.gene', async (j) => {
  const c = toCtx(j);
  const { recordId } = j.payload as { recordId: string };
  processing(c, recordId);
  const t = tableOf(recordId)!;
  const id = String(valueOf(t, recordId, 'geneId') ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Fatal('Add an NCBI Gene ID (digits only) first.');
  const g = await importGeneById(c, id, { recordId });
  if (!g) throw new Fatal(`NCBI Gene has no entry ${id}`);
  done(c, recordId);
  return { symbol: g.symbol, summary: `Retrieved gene ${g.symbol}`, _notify: { kind: 'fetch_completed', title: `Retrieved gene ${g.symbol}`, link: `/record/${recordId}` } };
});

/** The headline workflow: DNA -> gene -> protein -> structure + chemicals, with real progress counts and per-step notes. */
registerJob('pipeline.full', async (j) => {
  const c = toCtx(j);
  const p = j.payload as { recordId: string; steps?: { genes?: boolean; proteins?: boolean; structures?: boolean; chemicals?: boolean }; maxProteins?: number; maxCompounds?: number };
  const steps = { genes: true, proteins: true, structures: true, chemicals: true, ...p.steps };
  const t = tableOf(p.recordId);
  if (!t) throw new Fatal('Record not found');
  const kind = q.get<{ kind: string }>('SELECT kind FROM tables WHERE id=?', t)!.kind;
  const report: Record<string, unknown> = { start: kind, genes: [], proteins: [], structures: [], chemicals: 0, notes: [] as string[] };
  const notes = report.notes as string[];
  processing(c, p.recordId);
  let units = 0, doneUnits = 0;
  const tick = (msg: string) => j.progress(doneUnits, units || null, msg);

  let geneIds: string[] = [];
  if (kind === 'dna' || kind === 'rna') {
    const acc = String(valueOf(t, p.recordId, 'accession') ?? '').trim();
    const seq = String(valueOf(t, p.recordId, 'sequence') ?? '');
    if (acc && !seq) { tick('Fetching nucleotide record'); const r = await importNucleotide(c, acc, { recordId: p.recordId }); notes.push(`${r.classification.cls}: ${r.classification.note}`); }
    guard(j);
    if (steps.genes) {
      tick('Finding genes');
      const g = await discoverGenes(c, p.recordId, { progress: (m) => tick(m) });
      applyClassification(c, p.recordId, g.classification, 'VierStation sequence classification');
      report.genes = g.genes; notes.push(...g.notes);
      geneIds = g.genes.map((x) => x.geneRecordId);
    }
  } else if (kind === 'gene') geneIds = [p.recordId];

  let proteinIds: string[] = [];
  if (kind === 'protein') proteinIds = [p.recordId];
  else if (steps.proteins) {
    units = geneIds.length;
    for (const gid of geneIds.slice(0, 8)) {
      guard(j);
      tick('Finding proteins');
      const pr = await discoverProteins(c, gid, {});
      (report.proteins as unknown[]).push(...pr.proteins); notes.push(...pr.notes);
      proteinIds.push(...pr.proteins.filter((x) => x.isoform === 'canonical').map((x) => x.recordId));
      doneUnits++;
    }
  }
  proteinIds = [...new Set(proteinIds)].slice(0, p.maxProteins ?? 5);
  units = proteinIds.length * ((steps.structures ? 1 : 0) + (steps.chemicals ? 1 : 0));
  doneUnits = 0;
  for (const pid of proteinIds) {
    if (steps.structures) {
      guard(j); tick('Retrieving structures');
      try { (report.structures as unknown[]).push(await discoverStructures(c, pid)); } catch (e) { if (e instanceof Cancelled) throw e; notes.push(`Structures: ${(e as Error).message}`); }
      doneUnits++;
    }
    if (steps.chemicals) {
      guard(j); tick('Searching chemicals');
      try {
        const r = await discoverChemicals(c, pid, { maxCompounds: p.maxCompounds ?? 20 });
        report.chemicals = Number(report.chemicals) + r.chemicals.length; notes.push(...r.notes);
        for (const ch of r.chemicals.slice(0, 20)) { guard(j); try { await enrichChemical(c, ch.recordId); } catch (e) { if (e instanceof Cancelled) throw e; notes.push(`PubChem: ${(e as Error).message}`); break; } }
      } catch (e) { if (e instanceof Cancelled) throw e; notes.push(`Chemicals: ${(e as Error).message}`); }
      doneUnits++;
    }
  }
  const nGenes = (report.genes as unknown[]).length;
  done(c, p.recordId, kind === 'dna' && !nGenes && steps.genes);
  const summary = `${nGenes} gene(s), ${(report.proteins as unknown[]).length} protein record(s), ${(report.structures as any[]).filter((s) => s.alphafold?.available || s.experimental?.length).length} structure set(s), ${report.chemicals} compound link(s)`;
  return { ...report, summary, _notify: { kind: 'fetch_completed', title: 'Pipeline finished', body: summary, link: `/record/${p.recordId}` } };
}, { maxAttempts: 2 });

/** Import a search hit (by database + id) as a record. */
registerJob('import.hit', async (j) => {
  const c = toCtx(j);
  const { db, id } = j.payload as { db: string; id: string };
  let recordId: string | undefined, name = id;
  if (db === 'nuccore') { const r = await importNucleotide(c, id, { query: id }); recordId = r.recordId; name = r.accession; }
  else if (db === 'gene') { const r = await importGeneById(c, id, { fromQuery: `GeneID ${id}` }); if (!r) throw new Fatal(`No NCBI gene ${id}`); recordId = r.recordId; name = r.symbol; }
  else if (db === 'uniprot') { const r = await importProteinByAccession(c, id); recordId = r.recordId; name = r.name; await enrichDomains(c, r.recordId).catch(() => 0); }
  else if (db === 'pubchem') {
    const cid = (await resolveChemical(id, c.signal))[0];
    if (!cid) throw new Fatal(`PubChem has no compound for "${id}"`);
    const [pr] = await propsForCids([cid], c.signal);
    const tbl = tableOfKind(c, 'chemical');
    const r = upsertByKey(c, tbl, 'cid', cid, { name: pr?.title || id, inchikey: pr?.inchiKey, formula: pr?.formula, mw: pr?.molecularWeight ?? undefined, smiles: pr?.smiles, isoSmiles: pr?.isoSmiles, inchi: pr?.inchi, source: 'PubChem', retrieved: now() },
      { sourceDb: 'PubChem', accession: cid, query: id, url: pubchemUrl(cid), step: 'import' }, { alsoMatch: [['inchikey', pr?.inchiKey ?? '']] });
    recordId = r.id; name = pr?.title || id;
    await enrichChemical(c, r.id).catch(() => null);
    done(c, r.id);
  } else if (db === 'pdb') {
    const e = await pdbEntry(id, c.signal);
    if (!e) throw new Fatal(`RCSB PDB has no entry ${id}`);
    const tbl = tableOfKind(c, 'structure');
    const method = /ELECTRON MICRO/i.test(e.method) ? 'Cryo-EM' : /NMR/i.test(e.method) ? 'NMR' : /X-RAY/i.test(e.method) ? 'X-ray' : 'Other experimental';
    const r = upsertByKey(c, tbl, 'accession', e.id, {
      name: `${e.id} – ${e.title.slice(0, 80)}`, source: 'RCSB PDB', method, resolution: e.resolution ?? undefined, retrieved: now(),
      structure: { source: 'pdb', id: e.id, method: e.method, title: e.title, resolution: e.resolution ?? undefined, fileUrl: pdbFileUrl(e.id), url: pdbUrl(e.id), predicted: false, retrievedAt: now() },
    }, { sourceDb: 'RCSB PDB', accession: e.id, query: id, url: pdbUrl(e.id), step: 'import' });
    recordId = r.id; name = e.id;
    done(c, r.id);
  } else throw new Fatal(`Importing from "${db}" is not supported`);
  return { recordId, summary: `Imported ${name}`, _notify: { kind: 'fetch_completed', title: `Imported ${name}`, link: recordId ? `/record/${recordId}` : undefined } };
});

// A job that exhausts its attempts marks the record Failed so Kanban boards and the "Failed fetch → review task" automation can react.
onJobFinished((job, payload) => {
  if (job.status !== 'failed' || !payload?.recordId) return;
  const t = tableOf(payload.recordId);
  if (!t) return;
  try { setStatus(t, payload.recordId, 'Failed', { workspaceId: job.workspaceId, projectId: job.projectId, userId: job.createdBy, log: () => {}, origin: { jobId: job.id, depth: 1 } }); } catch { /* record may have been deleted */ }
});

/** Search databases by a pasted sequence (NCBI BLAST). DNA -> RefSeq transcripts, protein -> Swiss-Prot. Returns ranked hits with identity/coverage. */
registerJob('blast.sequence', async (j) => {
  const { seq, kind } = j.payload as { seq: string; kind: 'dna' | 'protein' };
  const { blastRun } = await import('../integrations/ncbi.ts');
  const program = kind === 'protein' ? 'blastp' : 'blastn';
  const db = kind === 'protein' ? 'swissprot' : 'refseq_rna';
  const res = await blastRun(seq, { db, program, hitlist: 10, signal: j.signal, onWait: (m) => { j.log(m); j.progress(0, null, m); } });
  const hits = res.hits.map((h) => ({ accession: h.accession, title: h.title, organism: h.organism, identityPct: h.bestIdentityPct, coveragePct: h.queryCoveragePct, evalue: h.hsps[0]?.evalue, db: kind === 'protein' ? 'uniprot' : 'nuccore' }));
  return { kind, db, queryLength: res.queryLength, hits, summary: hits.length ? `${hits.length} hit(s); best ${hits[0].accession} (${hits[0].identityPct}% identity)` : 'No significant hits', _notify: { kind: 'fetch_completed', title: hits.length ? `Sequence matches ${hits[0].accession}` : 'No sequence hits', body: `${hits.length} hit(s) in ${db}`, link: `/jobs/${j.id}` } };
}, { maxAttempts: 2 });
