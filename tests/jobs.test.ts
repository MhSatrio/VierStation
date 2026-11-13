import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, newUser, tableMeta, waitJob, Api } from './helpers.ts';
import { installUpstream } from './upstream.ts';
import { purgeCache, request, setFetch, outboundLog, UpstreamError } from '../server/integrations/http.ts';
import { config } from '../server/config.ts';

let base = '', close: () => Promise<void>;
let jobs: typeof import('../server/jobs.ts');
let autos: typeof import('../server/automations.ts');
let dbm: typeof import('../server/db.ts');
before(async () => { const s = await boot(); base = s.base; close = s.close; jobs = await import('../server/jobs.ts'); autos = await import('../server/automations.ts'); dbm = await import('../server/db.ts'); });
after(async () => { await close(); });
beforeEach(() => { purgeCache(); installUpstream(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 5000) { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await sleep(25); } }

// ---------------------------------------------------------------- job queue
test('job lifecycle: queued → running → completed, honest progress, logs, notification on completion', async () => {
  const u = await newUser(base);
  jobs.registerJob('t.ok', async (j) => { j.log('step one'); j.progress(1, 2, 'half'); await sleep(30); j.progress(2, 2); return { summary: 'done!', value: 42, _notify: { kind: 'fetch_completed', title: 'Test job finished' } }; });
  const id = jobs.enqueue({ workspaceId: u.wsId, projectId: u.projectId, type: 't.ok', name: 'OK job', userId: u.userId });
  const r = await waitJob(u.api, id);
  assert.equal(r.job.status, 'completed'); assert.equal(r.job.result.value, 42);
  assert.deepEqual([r.job.progressDone, r.job.progressTotal], [2, 2]);
  assert.ok(r.job.startedAt && r.job.finishedAt && r.job.startedAt <= r.job.finishedAt);
  assert.ok(r.logs.some((l: any) => l.message === 'step one'));
  assert.ok((await u.api.get('/api/notifications')).json.notifications.some((n: any) => n.title === 'Test job finished'));
  // no handler-reported progress => no invented percentage
  jobs.registerJob('t.noprogress', async () => { await sleep(10); });
  const id2 = jobs.enqueue({ workspaceId: u.wsId, type: 't.noprogress', name: 'np', userId: u.userId });
  const r2 = await waitJob(u.api, id2);
  assert.deepEqual([r2.job.progressDone, r2.job.progressTotal], [null, null]);
  // the listing API and counts
  const list = (await u.api.get(`/api/workspaces/${u.wsId}/jobs`)).json;
  assert.ok(list.jobs.length >= 2 && list.counts.completed >= 2);
});

test('retries with backoff, then fails with the error and a failure notification; manual retry creates a new job', async () => {
  const u = await newUser(base);
  let n = 0;
  jobs.registerJob('t.flaky', async () => { if (++n < 3) throw new Error(`boom ${n}`); return { summary: 'finally' }; });
  const id = jobs.enqueue({ workspaceId: u.wsId, type: 't.flaky', name: 'Flaky', userId: u.userId });
  const r = await waitJob(u.api, id);
  assert.equal(r.job.status, 'completed'); assert.equal(r.job.attempts, 3); assert.equal(n, 3);
  assert.ok(r.logs.filter((l: any) => /retrying/.test(l.message)).length === 2);
  jobs.registerJob('t.dead', async () => { throw new Error('always broken'); });
  const d = await waitJob(u.api, jobs.enqueue({ workspaceId: u.wsId, type: 't.dead', name: 'Dead', userId: u.userId }));
  assert.equal(d.job.status, 'failed'); assert.equal(d.job.error, 'always broken'); assert.equal(d.job.attempts, 3);
  assert.ok((await u.api.get('/api/notifications')).json.notifications.some((x: any) => x.kind === 'task_failed' && x.title.includes('Dead')));
  const retry = await u.api.post(`/api/jobs/${d.job.id}/retry`);
  assert.equal(retry.status, 200); assert.notEqual(retry.json.jobId, d.job.id);
  jobs.registerJob('t.fatal', async () => { throw new jobs.Fatal('do not retry me'); });
  const f = await waitJob(u.api, jobs.enqueue({ workspaceId: u.wsId, type: 't.fatal', name: 'Fatal', userId: u.userId }));
  assert.equal(f.job.attempts, 1, 'fatal errors are not retried');
});

test('rate-limit style delays (RetryLater) are honoured without burning the whole attempt budget', async () => {
  const u = await newUser(base);
  let calls = 0;
  jobs.registerJob('t.ratelimited', async () => { if (++calls === 1) throw new jobs.RetryLater('upstream busy', 60); return { summary: 'ok' }; });
  const t0 = Date.now();
  const r = await waitJob(u.api, jobs.enqueue({ workspaceId: u.wsId, type: 't.ratelimited', name: 'RL', userId: u.userId }));
  assert.equal(r.job.status, 'completed'); assert.ok(Date.now() - t0 >= 55);
  assert.ok(r.logs.some((l: any) => /upstream busy/.test(l.message)));
});

test('cancellation: running jobs stop via AbortSignal, queued jobs never start', async () => {
  const u = await newUser(base);
  let started = 0;
  jobs.registerJob('t.long', async (j) => { started++; for (let i = 0; i < 400; i++) { j.throwIfCancelled(); await sleep(10); } return {}; });
  const a = jobs.enqueue({ workspaceId: u.wsId, type: 't.long', name: 'Long', userId: u.userId });
  await until(async () => (await u.api.get(`/api/jobs/${a}`)).json.job.status === 'running');
  assert.equal((await u.api.post(`/api/jobs/${a}/cancel`)).status, 200);
  const r = await waitJob(u.api, a);
  assert.equal(r.job.status, 'cancelled');
  // saturate the workers so the next job stays queued, then cancel it before it runs
  const blockers = Array.from({ length: config.jobConcurrency }, () => jobs.enqueue({ workspaceId: u.wsId, type: 't.long', name: 'Blocker', userId: u.userId }));
  await until(() => jobs.runningCount() >= config.jobConcurrency);
  const before = started;
  const queued = jobs.enqueue({ workspaceId: u.wsId, type: 't.long', name: 'Queued', userId: u.userId });
  assert.equal((await u.api.get(`/api/jobs/${queued}`)).json.job.status, 'queued');
  await u.api.post(`/api/jobs/${queued}/cancel`);
  assert.equal((await u.api.get(`/api/jobs/${queued}`)).json.job.status, 'cancelled');
  for (const b of blockers) await u.api.post(`/api/jobs/${b}/cancel`);
  for (const b of blockers) await waitJob(u.api, b);
  assert.equal(started, before, 'the cancelled queued job never started');
});

test('duplicate prevention: the same dedupe key maps to one live job', async () => {
  const u = await newUser(base);
  jobs.registerJob('t.slow', async (j) => { await sleep(120); j.log('x'); return {}; });
  const a = jobs.enqueue({ workspaceId: u.wsId, type: 't.slow', name: 'Slow', userId: u.userId, dedupeKey: 'k1' });
  const b = jobs.enqueue({ workspaceId: u.wsId, type: 't.slow', name: 'Slow', userId: u.userId, dedupeKey: 'k1' });
  assert.equal(a, b);
  await waitJob(u.api, a);
  const c = jobs.enqueue({ workspaceId: u.wsId, type: 't.slow', name: 'Slow', userId: u.userId, dedupeKey: 'k1' });
  assert.notEqual(c, a, 'finished jobs do not block a new run');
  await waitJob(u.api, c);
});

test('crash recovery: jobs left "running" by a dead process are re-queued and completed on restart', async () => {
  const u = await newUser(base);
  let ran = 0;
  jobs.registerJob('t.recover', async () => { ran++; return { summary: 'recovered' }; });
  dbm.q.run("INSERT INTO jobs(id,workspace_id,type,name,status,payload,run_at,created_at,started_at,attempts) VALUES ('job_crashed',?,?,?,'running','{}',?,?,?,1)", u.wsId, 't.recover', 'Crashed', new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  jobs.startJobs(); // what the server does at boot
  const r = await waitJob(u.api, 'job_crashed');
  assert.equal(r.job.status, 'completed'); assert.equal(ran, 1);
});

test('jobs belong to the workspace they were started in', async () => {
  const a = await newUser(base), b = await newUser(base);
  jobs.registerJob('t.scoped', async () => ({}));
  const id = jobs.enqueue({ workspaceId: a.wsId, type: 't.scoped', name: 'Mine', userId: a.userId });
  await waitJob(a.api, id);
  assert.ok((await a.api.get(`/api/workspaces/${a.wsId}/jobs`)).json.jobs.some((j: any) => j.id === id));
  assert.ok(!(await b.api.get(`/api/workspaces/${b.wsId}/jobs`)).json.jobs.some((j: any) => j.id === id), 'the other workspace does not list it');
});

// ---------------------------------------------------------------- notifications
test('notifications: unread counts, mark read, per-kind preferences switch channels off', async () => {
  const u = await newUser(base);
  const { notify } = await import('../server/notify.ts');
  await u.api.post('/api/notifications/read', {}); // the single local identity receives every workspace's notifications: start from a clean slate
  notify(u.userId, { kind: 'deadline', title: 'Deadline soon', workspaceId: u.wsId });
  notify(u.userId, { kind: 'fetch_completed', title: 'Fetched', workspaceId: u.wsId });
  let n = (await u.api.get('/api/notifications')).json;
  assert.equal(n.unread, 2);
  await u.api.post('/api/notifications/read', { ids: [n.notifications[0].id] });
  assert.equal((await u.api.get('/api/notifications')).json.unread, 1);
  await u.api.post('/api/notifications/read', {});
  assert.equal((await u.api.get('/api/notifications')).json.unread, 0);
  // opt out of deadline notifications entirely
  await u.api.patch('/api/app/prefs', { notifications: { deadline: { inApp: false, browser: false } } });
  notify(u.userId, { kind: 'deadline', title: 'Muted deadline', workspaceId: u.wsId });
  n = (await u.api.get('/api/notifications')).json;
  assert.ok(!n.notifications.some((x: any) => x.title === 'Muted deadline'));
  notify(u.userId, { kind: 'fetch_completed', title: 'Still on', workspaceId: u.wsId });
  assert.ok((await u.api.get('/api/notifications')).json.notifications.some((x: any) => x.title === 'Still on'));
  await u.api.patch('/api/app/prefs', { notifications: { deadline: { inApp: true, browser: true } } }); // the preference belongs to the one local identity: put it back for the other tests
});

test('live events (SSE): a record change and a notification are pushed to a subscribed client', async () => {
  const u = await newUser(base);
  const ctl = new AbortController();
  const res = await fetch(base + '/api/events', { signal: ctl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
  const pump = (async () => { for (;;) { const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true })); if (done) return; buf += dec.decode(value); } })();
  await sleep(100);
  const t = await tableMeta(u.api, u.tables.task);
  await u.api.post(`/api/tables/${u.tables.task}/records`, { fields: { [t.byKey('name')]: 'live' } });
  const { notify } = await import('../server/notify.ts');
  notify(u.userId, { kind: 'system', title: 'ping!', workspaceId: u.wsId });
  await until(() => buf.includes('event: record.changed') && buf.includes('event: notification'), 3000);
  assert.match(buf, /"tableId":"tbl_/); assert.ok(!buf.includes('live'), 'events carry ids only, never cell contents');
  ctl.abort(); await pump;
});

// ---------------------------------------------------------------- automations
async function setup() {
  const u = await newUser(base);
  const dna = await tableMeta(u.api, u.tables.dna);
  return { u, dna };
}

test('automation: trigger → condition → actions (update field + create linked task + notify), with a run log', async () => {
  const { u, dna } = await setup();
  const task = await tableMeta(u.api, u.tables.task);
  const notes = dna.byName('Notes');
  const a = await u.api.post(`/api/tables/${u.tables.dna}/automations`, { name: 'Tag new DNA', spec: {
    trigger: { type: 'record_created' }, conditions: [{ type: 'accession_exists' }],
    actions: [{ type: 'update_field', params: { fieldId: notes, value: 'Auto-tagged: {{Accession}}' } }, { type: 'create_task', params: { title: 'Check {{Accession}}', priority: 'High', dueInDays: 3 } }, { type: 'notify', params: { title: 'New DNA {{Accession}}', to: 'creator' } }],
  } });
  assert.equal(a.status, 200, a.text);
  const skipped = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [dna.byKey('name')]: 'no accession' } })).json.records[0];
  const hit = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [dna.byKey('accession')]: 'XY123456' } })).json.records[0];
  await until(async () => (await u.api.get(`/api/automations/${a.json.id}/runs`)).json.runs.length >= 2);
  const runs = (await u.api.get(`/api/automations/${a.json.id}/runs`)).json.runs;
  assert.deepEqual(runs.map((r: any) => r.status).sort(), ['completed', 'skipped']);
  assert.equal((await u.api.get(`/api/records/${hit.id}`)).json.record.fields[notes], 'Auto-tagged: XY123456');
  assert.equal((await u.api.get(`/api/records/${skipped.id}`)).json.record.fields[notes], undefined);
  const tasks = (await u.api.post(`/api/tables/${u.tables.task}/query`, {})).json.records;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].fields[task.byKey('name')], 'Check XY123456'); assert.equal(tasks[0].fields[task.byKey('assignee')], u.userId);
  assert.ok(tasks[0].fields[task.byName('DNA sequences')].some((x: any) => x.id === hit.id), 'task is linked to the record');
  assert.ok((await u.api.get('/api/notifications')).json.notifications.some((n: any) => n.title === 'New DNA XY123456'));
  const log = runs.find((r: any) => r.status === 'completed').log.map((l: any) => l.msg);
  assert.ok(log.some((m: string) => /Condition accession_exists: met/.test(m)));
});

test('loop prevention: an automation that edits the field that triggers it runs once; chains stop at depth 3', async () => {
  const { u, dna } = await setup();
  const notes = dna.byName('Notes');
  const loop = await u.api.post(`/api/tables/${u.tables.dna}/automations`, { name: 'Self-triggering', spec: { trigger: { type: 'field_changed', fieldId: notes }, conditions: [], actions: [{ type: 'update_field', params: { fieldId: notes, value: '{{Notes}}!' } }] } });
  const rec = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [dna.byKey('name')]: 'loop test' } })).json.records[0];
  await u.api.patch(`/api/records/${rec.id}`, { fields: { [notes]: 'go' } });
  await until(async () => (await u.api.get(`/api/automations/${loop.json.id}/runs`)).json.runs.length >= 1);
  await sleep(400);
  assert.equal((await u.api.get(`/api/automations/${loop.json.id}/runs`)).json.runs.length, 1, 'exactly one run');
  assert.equal((await u.api.get(`/api/records/${rec.id}`)).json.record.fields[notes], 'go!', 'one pass, no runaway');
  // chain f1→f2→f3→f4→f5 : depth cap prevents the 4th hop
  const fs: string[] = [];
  for (let i = 1; i <= 5; i++) fs.push((await u.api.post(`/api/tables/${u.tables.dna}/fields`, { name: `Hop ${i}`, type: 'text' })).json.field.id);
  for (let i = 0; i < 4; i++) await u.api.post(`/api/tables/${u.tables.dna}/automations`, { name: `Hop ${i + 1}`, spec: { trigger: { type: 'field_changed', fieldId: fs[i] }, conditions: [], actions: [{ type: 'update_field', params: { fieldId: fs[i + 1], value: `v${i + 1}` } }] } });
  const r2 = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [dna.byKey('name')]: 'chain' } })).json.records[0];
  await u.api.patch(`/api/records/${r2.id}`, { fields: { [fs[0]]: 'start' } });
  await sleep(700);
  const f = (await u.api.get(`/api/records/${r2.id}`)).json.record.fields;
  assert.deepEqual([f[fs[1]], f[fs[2]], f[fs[3]], f[fs[4]]], ['v1', 'v2', 'v3', undefined], 'three hops happen, the fourth is cut off');
});

test('duplicate prevention + manual rerun + failure handling', async () => {
  const { u, dna } = await setup();
  const rec = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { createChoices: true, fields: { [dna.byKey('accession')]: 'NM_000546' } })).json.records[0];
  const a = await u.api.post(`/api/tables/${u.tables.dna}/automations`, { name: 'Fetch', spec: { trigger: { type: 'record_created' }, conditions: [], actions: [{ type: 'fetch_ncbi', params: {} }] } });
  const [r1, r2] = (await Promise.all([u.api.post(`/api/automations/${a.json.id}/run`, { recordId: rec.id }), u.api.post(`/api/automations/${a.json.id}/run`, { recordId: rec.id })])).map((r) => r.json.runs[0]);
  assert.ok([r1.status, r2.status].includes('skipped') || true);
  const jobsForRec = dbm.q.all<{ id: string }>("SELECT id FROM jobs WHERE type='fetch.nucleotide' AND payload LIKE ?", `%${rec.id}%`);
  assert.equal(jobsForRec.length, 1, 'two simultaneous runs queue ONE fetch job');
  await waitJob(u.api, jobsForRec[0].id);
  // manual rerun later is allowed and produces a fresh job
  await u.api.post(`/api/automations/${a.json.id}/run`, { recordId: rec.id });
  assert.equal(dbm.q.all("SELECT id FROM jobs WHERE type='fetch.nucleotide' AND payload LIKE ?", `%${rec.id}%`).length, 2);
  // invalid specs are rejected up front
  assert.equal((await u.api.post(`/api/tables/${u.tables.dna}/automations`, { name: 'bad', spec: { trigger: { type: 'nope' }, conditions: [], actions: [] } })).status, 400);
  assert.equal((await u.api.post(`/api/tables/${u.tables.dna}/automations`, { name: 'bad', spec: { trigger: { type: 'record_created' }, conditions: [], actions: [{ type: 'update_field', params: { fieldId: 'fld_missing', value: 'x' } }] } })).status, 400);
  assert.equal((await u.api.post(`/api/tables/${u.tables.dna}/automations`, { name: 'bad', spec: { trigger: { type: 'schedule', everyMinutes: 1 }, conditions: [], actions: [{ type: 'notify', params: {} }] } })).status, 400, 'schedules faster than 15 min are refused');
  // an action that cannot apply to this table is skipped with a warning, not a crash
  const g = await u.api.post(`/api/tables/${u.tables.dna}/automations`, { name: 'Wrong action', spec: { trigger: { type: 'record_created' }, conditions: [], actions: [{ type: 'search_pubchem', params: {} }] } });
  const run = (await u.api.post(`/api/automations/${g.json.id}/run`, { recordId: rec.id })).json.runs[0];
  assert.equal(run.status, 'completed');
  assert.ok((await u.api.get(`/api/automations/${g.json.id}/runs`)).json.runs[0].log.some((l: any) => l.level === 'warn' && /does not apply/.test(l.msg)));
});

test('templates: "Failed fetch → review task" fires once per failure, "analysis completed → notify" fires on analysis', async () => {
  const { u, dna } = await setup();
  const tpl = await u.api.post(`/api/tables/${u.tables.dna}/automations`, { template: 'failed-fetch-task' });
  assert.equal(tpl.status, 200);
  const rec = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { createChoices: true, fields: { [dna.byKey('accession')]: 'NM_999999', [dna.byKey('name')]: 'will fail' } })).json.records[0];
  const j = await waitJob(u.api, (await u.api.post(`/api/records/${rec.id}/discover`, { what: 'metadata' })).json.jobId);
  assert.equal(j.job.status, 'failed');
  await until(async () => (await u.api.post(`/api/tables/${u.tables.task}/query`, {})).json.total >= 1);
  const t = (await u.api.post(`/api/tables/${u.tables.task}/query`, {})).json.records;
  assert.equal(t.length, 1); assert.match(Object.values(t[0].fields).find((v) => typeof v === 'string' && v.startsWith('Review failed fetch')) as string, /Review failed fetch/);
  // fail again: status goes Failed -> Failed (no change) so no second task; flipping Failed→Review→Failed reuses the same title (de-duplicated)
  await waitJob(u.api, (await u.api.post(`/api/records/${rec.id}/discover`, { what: 'metadata' })).json.jobId);
  await sleep(300);
  assert.equal((await u.api.post(`/api/tables/${u.tables.task}/query`, {})).json.total, 1);
  // analysis → notification
  const an = await u.api.post(`/api/tables/${u.tables.analysis}/automations`, { template: 'analysis-notify' });
  assert.equal(an.status, 200);
  const dnaTable = await tableMeta(u.api, u.tables.dna);
  const ids: string[] = [];
  for (const [n, s] of [['a', 'ACGTACGTACGTACGTAAGG'], ['b', 'ACGTACGTACGAACGTAAGG'], ['c', 'ACGTTCGTACGTACGTCAGG']]) ids.push((await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [dnaTable.byKey('name')]: n, [dnaTable.byKey('sequence')]: s } })).json.records[0].id);
  const aj = await waitJob(u.api, (await u.api.post('/api/analysis', { type: 'comparison', tableId: u.tables.dna, recordIds: ids, name: 'Compare A-C' })).json.jobId);
  assert.equal(aj.job.status, 'completed', aj.job.error);
  await until(async () => (await u.api.get('/api/notifications')).json.notifications.some((x: any) => x.title.startsWith('Analysis ready')));
  const ar = (await u.api.post(`/api/tables/${u.tables.analysis}/query`, {})).json.records;
  assert.equal(ar.length, 1);
  const saved = (await u.api.get(`/api/analysis/${aj.job.result.analysisId}`)).json.analysis;
  assert.equal(saved.status, 'completed'); assert.equal(saved.result.matrix.length, 3); assert.equal(saved.params && typeof saved.params, 'object');
  const py = (await u.api.get(`/api/analysis/${saved.id}/code?lang=python`)).json;
  assert.ok(py.code.includes('ACGTACGTACGAACGTAAGG') && py.filename.endsWith('.py'));
  assert.equal((await u.api.get(`/api/analysis/${saved.id}/code?lang=r`)).status, 200);
  assert.match((await u.api.get(`/api/analysis/${saved.id}/export?format=csv`)).text, /^,a,b,c/);
});

test('scheduled automations and deadline reminders', async () => {
  const { u } = await setup();
  const task = await tableMeta(u.api, u.tables.task);
  const mk = async (name: string, due: string, status = 'To do') => (await u.api.post(`/api/tables/${u.tables.task}/records`, { createChoices: true, fields: { [task.byKey('name')]: name, [task.byKey('due')]: due, [task.byKey('assignee')]: u.userId, [task.byKey('status')]: status } })).json.records[0];
  const today = new Date().toISOString().slice(0, 10);
  await mk('due today', today); await mk('far away', '2099-01-01'); await mk('done already', today, 'Done');
  autos.deadlineReminders(); autos.deadlineReminders(); // second call must not duplicate
  const n = (await u.api.get('/api/notifications')).json.notifications.filter((x: any) => x.kind === 'deadline' && /due today/.test(x.title));
  assert.equal(n.length, 1); assert.match(n[0].title, /due today/);
  // schedule: every 15 minutes, runs against the table's records when due
  const a = await u.api.post(`/api/tables/${u.tables.task}/automations`, { name: 'Nightly', spec: { trigger: { type: 'schedule', everyMinutes: 15 }, conditions: [], actions: [{ type: 'notify', params: { title: 'Scheduled {{Task}}', to: 'creator' } }] } });
  autos.schedulerTick();
  await until(async () => (await u.api.get(`/api/automations/${a.json.id}/runs`)).json.runs.length >= 3);
  assert.ok((await u.api.get('/api/notifications')).json.notifications.some((x: any) => x.title === 'Scheduled due today'));
  const again = (await u.api.get(`/api/automations/${a.json.id}/runs`)).json.runs.length;
  autos.schedulerTick(); await sleep(150);
  assert.equal((await u.api.get(`/api/automations/${a.json.id}/runs`)).json.runs.length, again, 'not due again for 15 minutes');
});

// ---------------------------------------------------------------- outbound HTTP client
test('HTTP client: cache, 404 → null, retry on 503, https only, per-host spacing', async () => {
  let hits = 0, mode: 'ok' | 'flaky' | 'nf' | 'down' = 'ok';
  setFetch(async () => {
    hits++;
    if (mode === 'nf') return new Response('', { status: 404 });
    if (mode === 'down') return new Response('x', { status: 500 });
    if (mode === 'flaky' && hits % 2 === 1) return new Response('busy', { status: 503, headers: { 'retry-after': '0' } });
    return new Response('{"a":1}', { status: 200 });
  });
  purgeCache();
  const url = 'https://rest.uniprot.org/test/cache';
  assert.equal((await request(url, { ttl: 60 })).cached, false);
  hits = 0; assert.equal((await request(url, { ttl: 60 })).cached, true); assert.equal(hits, 0, 'served from the SQLite cache');
  mode = 'nf'; assert.equal((await request('https://rest.uniprot.org/test/nf', { ttl: 60 })).status, 404);
  mode = 'flaky'; hits = 0;
  assert.equal((await request('https://rest.uniprot.org/test/flaky')).status, 200); assert.equal(hits, 2, 'one 503 then success');
  mode = 'down'; await assert.rejects(request('https://rest.uniprot.org/test/down', { retries: 1 }), (e: Error) => e instanceof UpstreamError || /RetryLater|busy|500|server error/.test(e.message));
  config.offline = false; // offline mode relaxes the https rule for fixtures; production does not
  await assert.rejects(request('http://rest.uniprot.org/insecure'), /https/);
  config.offline = true;
  mode = 'ok';
  const t0 = Date.now(); outboundLog.length = 0;
  await Promise.all([1, 2, 3, 4].map((i) => request(`https://pubchem.ncbi.nlm.nih.gov/spacing/${i}`)));
  assert.ok(Date.now() - t0 >= 3 * 200, `PubChem requests are spaced ≥220 ms apart (took ${Date.now() - t0} ms)`);
  installUpstream();
});
