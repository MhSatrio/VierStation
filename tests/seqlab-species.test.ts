// Species typed by name: Taxonomy lookup → taxon-restricted BLAST of the query → aligned region of the best record. Uses the synthetic NCBI (known truth).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, newUser, waitJob } from './helpers.ts';
import { installLabUpstream, calls, QUERY } from './lab-upstream.ts';
import { purgeCache } from '../server/integrations/http.ts';
import { config } from '../server/config.ts';

let close: () => Promise<void>;
let u: Awaited<ReturnType<typeof newUser>>;
before(async () => {
  const s = await boot(); close = s.close; u = await newUser(s.base);
  purgeCache(); installLabUpstream(); config.offline = false; config.blastMinWaitMs = 1; config.blastPollMs = 10;
});
after(async () => { config.offline = true; await close(); });

test('species typed by name are resolved, searched inside their taxon, added with reasons, and the failures are reported honestly', async () => {
  const imp = await u.api.post('/api/lab/import', { projectId: u.projectId, text: `>unknown\n${QUERY}` });
  const id = imp.json.recordIds[0], L = (p = '') => `/api/lab/${id}${p}`;
  let r = await u.api.post(L('/blast'), { params: { db: 'core_nt', program: 'megablast', hitlist: 50 } });
  assert.equal((await waitJob(u.api, r.json.jobId, 60_000)).job.status, 'completed');
  calls.length = 0;
  r = await u.api.post(L('/species'), { names: 'Alphus quintus\nGammus primus, Nonexistus fakeus' , role: 'ingroup' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const done = await waitJob(u.api, r.json.jobId, 60_000);
  assert.equal(done.job.status, 'completed', JSON.stringify(done.job.error));
  const ds = (await u.api.get(L('/dataset'))).json;
  const added = ds.members.filter((m: any) => m.source === 'species_name');
  assert.deepEqual(added.map((m: any) => m.organism).sort(), ['Alphus quintus', 'Gammus primus']);
  const aq = added.find((m: any) => m.organism === 'Alphus quintus');
  assert.equal(aq.accession, 'KZ000001.1'); assert.ok(aq.length >= 600 && aq.length <= 750, 'the aligned marker region, not the whole record');
  assert.match(aq.reasons.join(' '), /you typed "Alphus quintus"/); assert.match(aq.reasons.join(' '), /txid1011\[Organism:exp\]/);
  // each name triggered its own taxon-restricted BLAST; the unknown name triggered none
  const blasts = calls.filter((c) => c.method === 'POST' && c.url.includes('blast.ncbi')).map((c) => decodeURIComponent(c.body ?? ''));
  assert.equal(blasts.length, 2); assert.ok(blasts.some((b) => b.includes('txid1011[Organism:exp]')) && blasts.some((b) => b.includes('txid2001[Organism:exp]')));
  // honest report
  assert.equal(ds.species.notes.length, 3);
  assert.equal(ds.species.notes.find((n: any) => n.name === 'Nonexistus fakeus').status, 'not_found');
  assert.ok(ds.species.warnings.some((w: string) => /Nonexistus fakeus/.test(w)));
  // the same species again is skipped, not duplicated
  r = await u.api.post(L('/species'), { names: ['Alphus quintus', 'Alphus sextus'], role: 'outgroup' });
  assert.equal((await waitJob(u.api, r.json.jobId, 60_000)).job.status, 'completed');
  const ds2 = (await u.api.get(L('/dataset'))).json;
  assert.equal(ds2.members.filter((m: any) => m.organism === 'Alphus quintus').length, 1);
  assert.equal(ds2.members.find((m: any) => m.organism === 'Alphus sextus').role, 'outgroup');
  assert.equal(ds2.species.notes.find((n: any) => n.name === 'Alphus quintus').status, 'skipped');
  // logged operations + change log + script mention it
  const ops = (await u.api.get(L('/ops'))).json.ops; assert.equal(ops.filter((o: any) => o.step === 'species').length, 2);
  const md = (await u.api.get(L('/export/changelog'))).text; assert.match(md, /Add species by name/); assert.match(md, /Nonexistus fakeus/);
  assert.match((await u.api.get(L('/export/script?scope=workflow'))).json.code, /Species typed by name/);
  // nothing typed / too many
  assert.equal((await u.api.post(L('/species'), { names: '  ' })).status, 400);
  assert.equal((await u.api.post(L('/species'), { names: Array.from({ length: 13 }, (_, i) => `Sp${i}`) })).status, 400);
});

test('NCBI taxonomy server errors are retried, and a name is never reported unknown just because NCBI failed to answer', async () => {
  const { lab } = await import('./lab-upstream.ts');
  purgeCache(); // responses are cached for a day: make sure the injected errors are really requested
  const imp = await u.api.post('/api/lab/import', { projectId: u.projectId, text: `>unknown2\n${QUERY}` });
  const id = imp.json.recordIds[0], L = (p = '') => `/api/lab/${id}${p}`;
  let r = await u.api.post(L('/blast'), { params: { db: 'core_nt', program: 'megablast', hitlist: 50 } });
  assert.equal((await waitJob(u.api, r.json.jobId, 60_000)).job.status, 'completed');
  // two transient HTTP 500s, then NCBI answers
  lab.taxErrors = 2;
  r = await u.api.post(L('/species'), { names: 'Betus tertius' });
  assert.equal((await waitJob(u.api, r.json.jobId, 60_000)).job.status, 'completed');
  assert.ok((await u.api.get(L('/dataset'))).json.members.some((m: any) => m.organism === 'Betus tertius'), 'added after the retries');
  // NCBI never answers
  lab.taxErrors = 1000;
  r = await u.api.post(L('/species'), { names: 'Alphus septimus' });
  const done = await waitJob(u.api, r.json.jobId, 60_000); lab.taxErrors = 0;
  assert.equal(done.job.status, 'failed');
  const op = (await u.api.get(L('/ops'))).json.ops.filter((o: any) => o.step === 'species').at(-1);
  assert.match(op.error, /NCBI Taxonomy did not answer/); assert.doesNotMatch(op.error, /No taxon with this name/);
});
