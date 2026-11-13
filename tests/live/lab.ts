// LIVE end-to-end check of the Sequence Lab pipeline against the real NCBI (BLAST, taxonomy, efetch). Run: npm run live:lab
// Takes a few minutes (two BLAST searches). Uses a real human mitochondrial COI fragment so the correct answer is known (Homo sapiens; outgroups = other Hominidae). (16S fragments of E. coli, B. subtilis and S. aureus were tried first: they cannot separate species within those groups, the aligned sequences were identical and the tree step correctly refused – see README.)
import assert from 'node:assert/strict';
import { boot, newUser, waitJob } from '../helpers.ts';
import { config } from '../../server/config.ts';
import * as ncbi from '../../server/integrations/ncbi.ts';

config.offline = false;
const srv = await boot();
const u = await newUser(srv.base);
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
try {
  const acc = 'NC_012920.1'; // human mitochondrial genome (COI lies at 5904–7445); a variable protein-coding marker, unlike 16S in Staphylococcus/Bacillus/Escherichia
  const sum = await ncbi.nucSummary(acc); assert.ok(sum && sum.length >= 700, `record too short (${sum?.length})`);
  const fa = await ncbi.fetchFasta('nuccore', acc, { from: 6000, to: 6600 }); assert.ok(fa);
  const seq = fa!.split('\n').filter((l) => !l.startsWith('>')).join('');
  log(`query: COI fragment 6000–6600 of ${acc} (${seq.length} bp)`);
  const imp = await u.api.post('/api/lab/import', { projectId: u.projectId, text: `>human_COI_fragment\n${seq}`, marker: 'COI' });
  const id = imp.json.recordIds[0]; const L = (p = '') => `/api/lab/${id}${p}`;

  log('lineage check (taxonomy 562, 9606)');
  const lin = await ncbi.taxonomyLineage([562, 9606]);
  assert.equal(lin[0].name, 'Escherichia coli'); assert.ok(lin[0].lineage.some((n) => n.rank === 'family' && n.name === 'Enterobacteriaceae')); assert.ok(lin[1].lineage.some((n) => n.name === 'Chordata'));

  log('BLAST 1 (core_nt, megablast) …');
  const t0 = Date.now();
  let r = await u.api.post(L('/blast'), { params: { db: 'core_nt', program: 'megablast', hitlist: 100, expect: 0.05 } });
  let done = await waitJob(u.api, r.json.jobId, 1_500_000); assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const h = (await u.api.get(L('/hits'))).json;
  log(`BLAST done in ${Math.round((Date.now() - t0) / 1000)} s: ${h.total} hits; top: ${h.hits[0].organism} ${h.hits[0].accession} ${h.hits[0].identityPct}% id, ${h.hits[0].coveragePct}% cov, E=${h.hits[0].evalue}, bits ${h.hits[0].bitScore}, strand ${h.hits[0].strand}`);
  assert.ok(h.total >= 30); assert.ok(/Homo sapiens/.test(h.hits[0].organism), h.hits[0].organism);
  assert.ok(h.hits[0].identityPct > 99 && h.hits[0].coveragePct > 98 && h.hits[0].hsps[0].qseq && h.hits[0].hsps[0].midline, 'rich hit fields present');
  log(`strands in result: ${[...new Set(h.hits.map((x: any) => x.strand))].join(', ')}; HSP coordinate sample: ${JSON.stringify(h.hits.slice(0, 3).map((x: any) => [x.hsps[0].hitFrom, x.hsps[0].hitTo, x.hsps[0].strand]))}`);

  log('close relatives …');
  r = await u.api.post(L('/relatives'), { params: { maxRelatives: 8, minCoverage: 90, minIdentity: 85, maxPerGenus: 3, broaden: true, broadenMax: 5 } });
  done = await waitJob(u.api, r.json.jobId, 900_000); assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  let ds = (await u.api.get(L('/dataset'))).json;
  log(`dataset: ${ds.members.map((m: any) => `${m.organism} (${m.accession}, ${m.length} bp, ${m.region?.strand})`).join('; ')}`);
  log(`excluded: ${ds.excluded.length} (${[...new Set(ds.excluded.map((e: any) => e.reason.replace(/\d+/g, 'N').slice(0, 50)))].join(' | ')})`);
  assert.ok(ds.members.length >= 3, 'query + at least two relatives');
  assert.ok(ds.members.filter((m: any) => m.role === 'ingroup').every((m: any) => m.length > 400 && m.length < 900), 'regions are marker-sized');

  log('outgroup assistant (taxon-restricted BLAST) …');
  r = await u.api.post(L('/outgroups'), { params: { max: 5 } });
  done = await waitJob(u.api, r.json.jobId, 1_500_000); assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  ds = (await u.api.get(L('/dataset'))).json; const og = ds.outgroupAssistant;
  log(`scopes: ingroup ${og.scopes?.ingroup.name} (${og.scopes?.ingroup.rank}) / outside ${og.scopes?.outside.name} (${og.scopes?.outside.rank}); query ${og.entrez}`);
  log(`candidates (${og.candidates.length}): ${og.candidates.map((c: any) => `${c.organism} ${c.identityPct}%`).join('; ')}`); if (og.warnings.length) log(`warnings: ${og.warnings.join(' ')}`);
  assert.ok(og.candidates.length >= 1, 'at least one outgroup candidate');
  await u.api.post(L('/dataset'), { action: 'add_candidates', opId: og.opId, ids: og.candidates.map((c: any) => c.id), role: 'outgroup' });

  log('alignment (iterative) …');
  r = await u.api.post(L('/align'), { params: { method: 'iterative' } }); done = await waitJob(u.api, r.json.jobId, 120_000); assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const al = (await u.api.get(L('/alignment'))).json; log(`alignment: ${al.labels.length} × ${al.length}, SP ${al.spScore}`);

  log('tree (NJ, K2P, bootstrap 100) …');
  r = await u.api.post(L('/tree'), { params: { method: 'nj', distance: 'k2p', bootstrap: 100, rooting: 'outgroup' } }); done = await waitJob(u.api, r.json.jobId, 900_000); assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const t = (await u.api.get(L('/tree'))).json.result;
  log(`tree: ${t.rooting}; interpretation: ${t.interpretation.summary}`);
  log(`outgroups form own clade: ${t.interpretation.outgroupsFormOwnClade}; newick: ${t.newick.slice(0, 200)}…`);
  assert.ok(/Homo/.test(t.interpretation.statement) || t.interpretation.closestClade?.organisms.some((o: string) => /Homo/.test(o)), t.interpretation.statement);

  const md = (await u.api.get(L('/export/changelog'))).text; const sc = (await u.api.get(L('/export/script?scope=workflow'))).json;
  log(`exports OK: changelog ${md.length} chars, script ${sc.code.length} chars (${sc.reproducible})`);
  console.log('\nLIVE LAB CHECK PASSED');
} catch (e) { console.error('\nLIVE LAB CHECK FAILED:', (e as Error).stack); process.exitCode = 1; }
finally { await srv.close(); }
