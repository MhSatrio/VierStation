import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, newUser, tableMeta, Api } from './helpers.ts';

let base = '', close: () => Promise<void>;
before(async () => { const s = await boot(); base = s.base; close = s.close; });
after(async () => { await close(); });

test('local mode: no accounts, no login, no sessions – the app starts straight into its workspace', async () => {
  const st = await new Api(base).get('/api/app/state');
  assert.equal(st.status, 200);
  assert.equal(st.json.user.id, 'usr_local'); assert.ok(st.json.workspaces.length >= 1 && st.json.workspaces[0].role === 'owner');
  assert.ok(st.json.network && typeof st.json.network.offline === 'boolean');
  // everything that belonged to accounts is gone
  for (const p of ['/api/auth/me', '/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/auth/password']) {
    const r = await new Api(base).req(p === '/api/auth/me' ? 'GET' : 'POST', p, p === '/api/auth/me' ? undefined : {});
    assert.equal(r.status, 404, `${p} no longer exists`);
  }
  assert.equal((await new Api(base).post('/api/notifications/test-email', {})).status, 404, 'no e-mail infrastructure');
  assert.equal((await new Api(base).get('/api/workspaces/x/members')).status !== 401, true);
  const t = await newUser(base); // data is reachable without any credentials
  assert.equal((await t.api.get(`/api/workspaces/${t.wsId}/tables`)).status, 200);
});

test('local mode keeps its guards: CSRF header, and requests addressed to a foreign host name are refused (DNS rebinding)', async () => {
  const noHeader = await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
  assert.equal(noHeader.status, 403, 'mutating requests without X-VS are refused (CSRF)');
  const { request } = await import('node:http');
  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(base);
    const r = request({ host: u.hostname, port: u.port, path: '/api/app/state', headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on('error', reject); r.end();
  });
  assert.equal(status, 403, 'a Host header that is not localhost is refused');
});

test('privacy of the preferences endpoint: only known keys are stored', async () => {
  const api = new Api(base);
  const r = await api.patch('/api/app/prefs', { theme: 'dark', tooltips: false, defaults: { blastDb: 'nt', evil: { nested: 1 } }, junk: 'x' });
  assert.equal(r.status, 200);
  assert.equal(r.json.prefs.theme, 'dark'); assert.equal(r.json.prefs.tooltips, false); assert.equal(r.json.prefs.defaults.blastDb, 'nt');
  assert.equal(r.json.prefs.junk, undefined); assert.equal(r.json.prefs.defaults.evil, undefined);
  assert.equal((await api.patch('/api/app/prefs', { theme: 'system' })).json.prefs.theme, 'system');
});

test('a new workspace starts with the full pipeline project: tables, relations, views', async () => {
  const u = await newUser(base);
  assert.deepEqual(Object.keys(u.tables).sort(), ['analysis', 'chemical', 'dna', 'experiment', 'gene', 'organism', 'protein', 'publication', 'structure', 'task']);
  const dna = await tableMeta(u.api, u.tables.dna);
  assert.ok(dna.views.some((v: any) => v.type === 'grid') && dna.views.some((v: any) => v.type === 'kanban') && dna.views.some((v: any) => v.type === 'graph'));
  const rel = dna.fields.find((f: any) => f.name === 'Genes');
  assert.equal(rel.type, 'relation');
  assert.equal(rel.options.targetTable, u.tables.gene);
  const gene = await tableMeta(u.api, u.tables.gene);
  const inv = gene.fields.find((f: any) => f.id === rel.options.inverseFieldId);
  assert.ok(inv, 'inverse relation field exists on the linked table');
  assert.equal(inv.options.targetTable, u.tables.dna);
});

test('records: typed validation, select-by-name, computed fields cannot be set', async () => {
  const u = await newUser(base);
  const t = await tableMeta(u.api, u.tables.dna);
  const ok = await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [t.byKey('name')]: 'Seq A', [t.byKey('sequence')]: 'ggccaatt', [t.byKey('length')]: '8', [t.byKey('seqClass')]: 'Coding DNA' } });
  assert.equal(ok.status, 200);
  const rec = ok.json.records[0];
  assert.equal(rec.fields[t.byKey('sequence')], 'GGCCAATT', 'sequence normalised');
  assert.equal(rec.fields[t.byKey('length')], 8, 'numeric string coerced');
  assert.equal(rec.fields[t.byName('GC content')], 0.5, 'formula field computed');
  const sel = t.fields.find((f: any) => f.key === 'seqClass').options.choices.find((c: any) => c.name === 'Coding DNA').id;
  assert.equal(rec.fields[t.byKey('seqClass')], sel);
  const badNum = await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [t.byKey('length')]: 'abc' } });
  assert.equal(badNum.status, 400);
  const badSeq = await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [t.byKey('sequence')]: 'ACGT123XYZ!' } });
  assert.equal(badSeq.status, 400);
  const badSel = await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [t.byKey('seqClass')]: 'Not an option' } });
  assert.equal(badSel.status, 400);
  const computed = await u.api.patch(`/api/records/${rec.id}`, { fields: { [t.byName('GC content')]: 0.9 } });
  assert.equal(computed.status, 400);
  const unknown = await u.api.patch(`/api/records/${rec.id}`, { fields: { nonsense: 1 } });
  assert.equal(unknown.status, 400);
  const url = await u.api.post(`/api/tables/${u.tables.publication}/records`, { fields: { URL: 'javascript:alert(1)' } });
  assert.equal(url.status, 400, 'javascript: URLs are rejected');
});

test('links are real relations: both directions, evidence metadata, no cross-table ids', async () => {
  const u = await newUser(base);
  const dna = await tableMeta(u.api, u.tables.dna), gene = await tableMeta(u.api, u.tables.gene), prot = await tableMeta(u.api, u.tables.protein);
  const g = (await u.api.post(`/api/tables/${u.tables.gene}/records`, { fields: { [gene.byKey('name')]: 'TP53' } })).json.records[0];
  const d = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [dna.byKey('name')]: 'NM_000546', [dna.byName('Genes')]: [g.id] } })).json.records[0];
  assert.deepEqual(d.fields[dna.byName('Genes')].map((x: any) => x.name), ['TP53']);
  assert.equal(d.fields[dna.byName('Genes')][0].meta.evidenceClass, 'user_supplied', 'manual links are honestly labelled');
  const g2 = (await u.api.get(`/api/records/${g.id}`)).json.record;
  assert.deepEqual(g2.fields[gene.byName('DNA sequences')].map((x: any) => x.id), [d.id], 'inverse side shows the same link');
  // link a protein record to a DNA field -> rejected (wrong table)
  const p = (await u.api.post(`/api/tables/${u.tables.protein}/records`, { fields: { [prot.byKey('name')]: 'p53' } })).json.records[0];
  const wrong = await u.api.patch(`/api/records/${d.id}`, { fields: { [dna.byName('Genes')]: [p.id] } });
  assert.equal(wrong.status, 400);
  // edit from the inverse side removes from both
  await u.api.patch(`/api/records/${g.id}`, { fields: { [gene.byName('DNA sequences')]: [] } });
  assert.equal((await u.api.get(`/api/records/${d.id}`)).json.record.fields[dna.byName('Genes')].length, 0);
  // deleting a record removes its links
  await u.api.patch(`/api/records/${d.id}`, { fields: { [dna.byName('Genes')]: [g.id] } });
  await u.api.del(`/api/records/${g.id}`);
  assert.equal((await u.api.get(`/api/records/${d.id}`)).json.record.fields[dna.byName('Genes')].length, 0);
});

test('lookup, rollup and formula fields over linked records', async () => {
  const u = await newUser(base);
  const prot = await tableMeta(u.api, u.tables.protein), chem = await tableMeta(u.api, u.tables.chemical);
  const mk = async (tbl: string, f: Record<string, unknown>) => (await u.api.post(`/api/tables/${tbl}/records`, { fields: f })).json.records[0];
  const c1 = await mk(u.tables.chemical, { [chem.byKey('name')]: 'Imatinib', [chem.byKey('mw')]: 493.6 });
  const c2 = await mk(u.tables.chemical, { [chem.byKey('name')]: 'Dasatinib', [chem.byKey('mw')]: 488.0 });
  const p = await mk(u.tables.protein, { [prot.byKey('name')]: 'ABL1', [prot.byName('Chemicals')]: [c1.id, c2.id] });
  const rel = prot.byName('Chemicals');
  const look = await u.api.post(`/api/tables/${u.tables.protein}/fields`, { name: 'Ligand names', type: 'lookup', options: { relationField: rel, lookupField: chem.byKey('name') } });
  assert.equal(look.status, 200);
  const roll = await u.api.post(`/api/tables/${u.tables.protein}/fields`, { name: 'Mean ligand MW', type: 'rollup', options: { relationField: rel, lookupField: chem.byKey('mw'), rollupFn: 'avg' } });
  assert.equal(roll.status, 200);
  const cnt = await u.api.post(`/api/tables/${u.tables.protein}/fields`, { name: 'Ligand count', type: 'rollup', options: { relationField: rel, lookupField: chem.byKey('mw'), rollupFn: 'countAll' } });
  const fm = await u.api.post(`/api/tables/${u.tables.protein}/fields`, { name: 'Summary', type: 'formula', options: { formula: '{Name} & ": " & {Ligand count} & " ligands, mean MW " & ROUND({Mean ligand MW}, 1)' } });
  assert.equal(fm.status, 200);
  const r = (await u.api.get(`/api/records/${p.id}`)).json.record;
  assert.deepEqual(r.fields[look.json.field.id], ['Imatinib', 'Dasatinib']);
  assert.ok(Math.abs(r.fields[roll.json.field.id] - 490.8) < 1e-9);
  assert.equal(r.fields[cnt.json.field.id], 2);
  assert.equal(r.fields[fm.json.field.id], 'ABL1: 2 ligands, mean MW 490.8');
  // formula cycles and bad syntax are rejected/contained
  const bad = await u.api.post(`/api/tables/${u.tables.protein}/fields`, { name: 'Bad', type: 'formula', options: { formula: '1 +' } });
  assert.equal(bad.status, 400);
  const self = await u.api.post(`/api/tables/${u.tables.protein}/fields`, { name: 'Loop', type: 'formula', options: { formula: '{Loop} + 1' } });
  assert.equal(self.status, 400, 'self-referencing formula is refused');
  const a = await u.api.post(`/api/tables/${u.tables.protein}/fields`, { name: 'FA', type: 'formula', options: { formula: '{Ligand count} + 1' } });
  const b = await u.api.post(`/api/tables/${u.tables.protein}/fields`, { name: 'FB', type: 'formula', options: { formula: '{FA} * 2' } });
  assert.equal((await u.api.patch(`/api/fields/${a.json.field.id}`, { options: { formula: '{FB} + 1' } })).status, 400, 'indirect cycle refused');
  assert.equal((await u.api.get(`/api/records/${p.id}`)).json.record.fields[b.json.field.id], 6);
  await u.api.patch(`/api/fields/${a.json.field.id}`, { name: 'FA renamed' });
  assert.equal((await u.api.get(`/api/records/${p.id}`)).json.record.fields[b.json.field.id], 6, 'renaming a field keeps dependent formulas working');
  // the rollup is filterable/sortable (computed field in the query engine)
  const q = await u.api.post(`/api/tables/${u.tables.protein}/query`, { filter: { mode: 'and', items: [{ field: roll.json.field.id, op: 'gt', value: 490 }] } });
  assert.equal(q.json.total, 1);
});

test('query engine: filter, sort, group, search, paging agree across views', async () => {
  const u = await newUser(base);
  const t = await tableMeta(u.api, u.tables.dna);
  const rows = [['Alpha', 300, 'Coding DNA'], ['beta', 100, 'Non-coding DNA'], ['Gamma', 200, 'Coding DNA'], ['delta10', 50, 'Uncertain annotation'], ['delta2', 75, 'Coding DNA'], ['epsilon', null, null]];
  await u.api.post(`/api/tables/${u.tables.dna}/records`, { createChoices: true, records: rows.map(([n, l, c]) => ({ [t.byKey('name')]: n, ...(l !== null ? { [t.byKey('length')]: l } : {}), ...(c ? { [t.byKey('seqClass')]: c } : {}) })) });
  const Q = (b: object) => u.api.post(`/api/tables/${u.tables.dna}/query`, b);
  const names = (r: any) => r.json.records.map((x: any) => x.fields[t.byKey('name')]);
  assert.equal((await Q({})).json.total, 6);
  assert.deepEqual(names(await Q({ sorts: [{ field: t.byKey('length'), dir: 'asc' }] })), ['delta10', 'delta2', 'beta', 'Gamma', 'Alpha', 'epsilon'], 'numeric sort, empties last');
  assert.deepEqual(names(await Q({ sorts: [{ field: t.byKey('length'), dir: 'desc' }] })), ['Alpha', 'Gamma', 'beta', 'delta2', 'delta10', 'epsilon']);
  assert.deepEqual(names(await Q({ sorts: [{ field: t.byKey('name'), dir: 'asc' }] })).slice(0, 5), ['Alpha', 'beta', 'delta2', 'delta10', 'epsilon'], 'natural, case-insensitive text sort');
  const coding = t.fields.find((f: any) => f.key === 'seqClass').options.choices.find((c: any) => c.name === 'Coding DNA').id;
  const f1 = await Q({ filter: { mode: 'and', items: [{ field: t.byKey('seqClass'), op: 'is', value: coding }, { field: t.byKey('length'), op: 'gte', value: 100 }] } });
  assert.deepEqual(names(f1).sort(), ['Alpha', 'Gamma']);
  const g = await Q({ groupBy: { field: t.byKey('seqClass'), dir: 'asc' }, sorts: [{ field: t.byKey('length'), dir: 'desc' }] });
  assert.deepEqual(g.json.groups.map((x: any) => [x.label, x.count]), [['Coding DNA', 3], ['Non-coding DNA', 1], ['Uncertain annotation', 1], ['(empty)', 1]]);
  assert.deepEqual(names(g).slice(0, 3), ['Alpha', 'Gamma', 'delta2'], 'rows are contiguous per group and sorted inside');
  const page = await Q({ sorts: [{ field: t.byKey('name'), dir: 'asc' }], offset: 2, limit: 2 });
  assert.deepEqual(names(page), ['delta2', 'delta10']);
  assert.equal(page.json.total, 6);
  assert.deepEqual(names(await Q({ search: 'delta' })).sort(), ['delta10', 'delta2'], 'full-text search');
  assert.deepEqual(names(await Q({ search: 'gam' })), ['Gamma'], 'prefix search');
  assert.equal((await Q({ filter: { mode: 'bogus', items: [] } })).status, 400);
});

test('views share records: an edit made through one view is visible through the others; saved view config applies filters', async () => {
  const u = await newUser(base);
  const t = await tableMeta(u.api, u.tables.dna);
  const kan = t.views.find((v: any) => v.type === 'kanban');
  assert.ok(kan.config.kanbanField, 'kanban defaults to the Status field');
  const rec = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { createChoices: true, fields: { [t.byKey('name')]: 'K1', [t.byKey('status')]: 'To fetch' } })).json.records[0];
  // "drag" to Processing in the Kanban view = patch the status field
  await u.api.patch(`/api/records/${rec.id}`, { fields: { [t.byKey('status')]: 'Processing' } });
  const grid = t.views.find((v: any) => v.type === 'grid');
  const processing = t.fields.find((f: any) => f.key === 'status').options.choices.find((c: any) => c.name === 'Processing').id;
  const viaGrid = await u.api.post(`/api/tables/${u.tables.dna}/query`, { viewId: grid.id });
  assert.equal(viaGrid.json.records[0].fields[t.byKey('status')], processing);
  const viaKanban = await u.api.post(`/api/tables/${u.tables.dna}/query`, { viewId: kan.id, groupBy: { field: kan.config.kanbanField, dir: 'asc' } });
  assert.equal(viaKanban.json.groups.find((g: any) => g.key === processing).count, 1);
  // saved custom view with a filter
  const saved = await u.api.post(`/api/tables/${u.tables.dna}/views`, { name: 'Only processing', type: 'grid', config: { filter: { mode: 'and', items: [{ field: t.byKey('status'), op: 'is', value: processing }] }, hidden: [t.byKey('sequence')] } });
  assert.equal(saved.status, 200);
  await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [t.byKey('name')]: 'other' } });
  const q = await u.api.post(`/api/tables/${u.tables.dna}/query`, { viewId: saved.json.view.id });
  assert.equal(q.json.total, 1);
  assert.equal((await u.api.del(`/api/views/${saved.json.view.id}`)).status, 200);
});

test('fields: create, rename, reorder, convert type, delete (views and data are cleaned)', async () => {
  const u = await newUser(base);
  const t = await tableMeta(u.api, u.tables.experiment);
  const f = await u.api.post(`/api/tables/${u.tables.experiment}/fields`, { name: 'Replicates', type: 'text' });
  const id = f.json.field.id;
  const r = (await u.api.post(`/api/tables/${u.tables.experiment}/records`, { fields: { [t.byKey('name')]: 'E1', [id]: '3' } })).json.records[0];
  const dup = await u.api.post(`/api/tables/${u.tables.experiment}/fields`, { name: 'replicates', type: 'text' });
  assert.equal(dup.status, 400, 'field names are unique case-insensitively');
  const conv = await u.api.patch(`/api/fields/${id}`, { type: 'number' });
  assert.equal(conv.status, 200);
  assert.equal((await u.api.get(`/api/records/${r.id}`)).json.record.fields[id], 3, 'text converted to number');
  const ren = await u.api.patch(`/api/fields/${id}`, { name: 'Replicate count' });
  assert.equal(ren.json.field.name, 'Replicate count');
  const viewId = t.views[0].id;
  await u.api.patch(`/api/views/${viewId}`, { config: { hidden: [id], sorts: [{ field: id, dir: 'asc' }] } });
  const order = [id, ...t.fields.map((x: any) => x.id)];
  assert.equal((await u.api.put(`/api/tables/${u.tables.experiment}/fields/order`, { order })).status, 200);
  const primary = (await u.api.del(`/api/fields/${id}`));
  assert.equal(primary.status, 400, 'the primary field cannot be deleted');
  await u.api.put(`/api/tables/${u.tables.experiment}/fields/order`, { order: t.fields.map((x: any) => x.id) });
  assert.equal((await u.api.del(`/api/fields/${id}`)).status, 200);
  const after = (await u.api.get(`/api/tables/${u.tables.experiment}`)).json;
  assert.ok(!after.fields.some((x: any) => x.id === id));
  assert.deepEqual(after.views.find((v: any) => v.id === viewId).config.hidden, [], 'deleted field removed from view config');
  assert.equal(JSON.stringify((await u.api.get(`/api/records/${r.id}`)).json.record.fields).includes(id), false);
});

test('bulk operations and CSV export (with spreadsheet-injection guard)', async () => {
  const u = await newUser(base);
  const t = await tableMeta(u.api, u.tables.chemical);
  const made = (await u.api.post(`/api/tables/${u.tables.chemical}/records`, { createChoices: true, records: ['A', 'B', 'C'].map((n) => ({ [t.byKey('name')]: n, [t.byKey('status')]: 'To fetch' })) })).json.records;
  const ids = made.map((r: any) => r.id);
  const upd = await u.api.post(`/api/tables/${u.tables.chemical}/bulk`, { op: 'update', ids: ids.slice(0, 2), fields: { [t.byKey('status')]: 'Completed' } });
  assert.equal(upd.json.affected, 2);
  const evil = (await u.api.post(`/api/tables/${u.tables.chemical}/records`, { fields: { [t.byKey('name')]: '=HYPERLINK("http://evil","x")' } })).json.records[0];
  const csv = await u.api.post(`/api/tables/${u.tables.chemical}/export`, { format: 'csv' });
  assert.match(csv.text, /"'=HYPERLINK\(""http:\/\/evil"",""x""\)"/);
  assert.equal(csv.headers.get('content-disposition')?.startsWith('attachment'), true);
  const del = await u.api.post(`/api/tables/${u.tables.chemical}/bulk`, { op: 'delete', ids: [...ids, evil.id] });
  assert.equal(del.json.affected, 4);
  assert.equal((await u.api.post(`/api/tables/${u.tables.chemical}/query`, {})).json.total, 0);
});

test('workspaces are separate containers: another workspace\'s tables and search results never mix in', async () => {
  const one = await newUser(base, 'One');
  const two = await newUser(base, 'Two');
  const nameField = (await tableMeta(one.api, one.tables.experiment)).fields[0].id;
  await one.api.post(`/api/tables/${one.tables.experiment}/records`, { fields: { [nameField]: 'zebrafish-lab-notes' } });
  assert.equal((await one.api.get(`/api/workspaces/${one.wsId}/search?q=zebrafish`)).json.hits.length, 1);
  assert.equal((await two.api.get(`/api/workspaces/${two.wsId}/search?q=zebrafish`)).json.hits.length, 0, 'the other workspace does not see it');
  assert.ok(!(await two.api.get(`/api/workspaces/${two.wsId}/tables`)).json.tables.some((t: any) => t.id === one.tables.experiment));
  // membership management no longer exists
  assert.ok([404, 405].includes((await one.api.post(`/api/workspaces/${one.wsId}/members`, { email: 'x@y.zz', role: 'viewer' })).status), 'nobody can be added: there are no other people');
});

test('attachments: allow-list, content sniffing, no HTML/SVG, safe download headers', async () => {
  const u = await newUser(base);
  const up = (name: string, body: Buffer | string) => u.api.req('POST', `/api/workspaces/${u.wsId}/files?name=${encodeURIComponent(name)}`, typeof body === 'string' ? Buffer.from(body) : body, { 'content-type': 'application/octet-stream' });
  assert.equal((await up('seqs.fasta', '>a\nACGT\n')).status, 200);
  assert.equal((await up('evil.html', '<script>alert(1)</script>')).status, 400);
  assert.equal((await up('logo.svg', '<svg onload=alert(1)/>')).status, 400);
  assert.equal((await up('notes.txt', '<!DOCTYPE html><script>x</script>')).status, 400, 'markup disguised as txt');
  assert.equal((await up('fake.png', 'not really a png')).status, 400, 'extension must match content');
  assert.equal((await up('tool.exe', 'MZ....')).status, 400);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const ok = await up('fig.png', png);
  assert.equal(ok.status, 200);
  const dl = await fetch(base + `/api/files/${ok.json.file.id}`);
  assert.equal(dl.headers.get('content-disposition')?.startsWith('attachment'), true);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  // attach to a record
  const t = await tableMeta(u.api, u.tables.experiment);
  const f = (await u.api.post(`/api/tables/${u.tables.experiment}/fields`, { name: 'Gel', type: 'attachment' })).json.field;
  const r = await u.api.post(`/api/tables/${u.tables.experiment}/records`, { fields: { [t.byKey('name')]: 'E', [f.id]: [ok.json.file.id] } });
  assert.equal(r.json.records[0].fields[f.id][0].name, 'fig.png');
  assert.equal((await u.api.post(`/api/tables/${u.tables.experiment}/records`, { fields: { [f.id]: ['fil_doesnotexist'] } })).status, 400);
});

test('secrets are encrypted at rest and only ever returned masked', async () => {
  const u = await newUser(base);
  const put = await u.api.put(`/api/workspaces/${u.wsId}/secrets/ncbi_api_key`, { value: 'abcdef1234567890SECRET' });
  assert.equal(put.status, 200);
  const list = await u.api.get(`/api/workspaces/${u.wsId}/secrets`);
  assert.ok(!list.text.includes('abcdef1234567890SECRET'));
  assert.equal(list.json.secrets.find((s: any) => s.name === 'ncbi_api_key').set, true);
  const { db } = await import('../server/db.ts');
  const raw = db.prepare("SELECT enc FROM secrets WHERE name='ncbi_api_key'").get() as { enc: string };
  assert.ok(!raw.enc.includes('abcdef1234567890SECRET'));
  const audit = await u.api.get(`/api/workspaces/${u.wsId}/audit`);
  assert.ok(audit.json.entries.some((e: any) => e.action === 'secret.set'));
  assert.ok(!audit.text.includes('abcdef1234567890SECRET'), 'secret values never reach the audit log');
});

test('project dashboard aggregates server-side', async () => {
  const u = await newUser(base);
  const t = await tableMeta(u.api, u.tables.task);
  await u.api.post(`/api/tables/${u.tables.task}/records`, { createChoices: true, records: [
    { [t.byKey('name')]: 'T1', [t.byKey('status')]: 'Done' }, { [t.byKey('name')]: 'T2', [t.byKey('status')]: 'To do', [t.byKey('due')]: '2020-01-01' }, { [t.byKey('name')]: 'T3', [t.byKey('status')]: 'In progress', [t.byKey('due')]: '2099-01-01' },
  ] });
  const d = (await u.api.get(`/api/projects/${u.projectId}/dashboard?fresh=1`)).json;
  assert.equal(d.tasks.total, 3); assert.equal(d.tasks.done, 1); assert.equal(d.tasks.pending, 2); assert.equal(d.tasks.overdue, 1);
  assert.equal(d.progress.tasksPct, 33);
  assert.equal(d.deadlines[0].title, 'T2');
  assert.ok(d.recordCount >= 3);
});
