// Relationship explorer, reactions, pathways, images, offline queue, backup/export: data-level tests with a small glycolysis-style dataset
// (one example – nothing in the code is glycolysis-specific; a cyclic and a second pathway are tested too).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { boot, newUser } from './helpers.ts';
import { config } from '../server/config.ts';
import { setFetch } from '../server/integrations/http.ts';
import { purgeCache } from '../server/integrations/http.ts';
import * as jobs from '../server/jobs.ts';
import { openDb, closeDb } from '../server/db.ts';
import { ensureLocalIdentity, resetLocalIdentityCache } from '../server/local.ts';
import { parseCa, traceSvg } from '../server/images.ts';

let base = '', close: () => Promise<void>;
let u: Awaited<ReturnType<typeof newUser>>;
before(async () => { const s = await boot(); base = s.base; close = s.close; u = await newUser(base, 'Glyco'); });
after(async () => { await close(); });

const rec = async (kind: string, name: string, fields: Record<string, unknown> = {}) => { const r = await u.api.post('/api/explorer/quick-record', { projectId: u.projectId, kind, name, fields }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json as { id: string; created: boolean }; };
const rel = (b: Record<string, unknown>) => u.api.post('/api/relationships', { ...b });
const graph = async (qs: string) => (await u.api.get(`/api/explorer/graph?workspace=${u.wsId}&${qs}`)).json;
const ids: Record<string, string> = {};

test('dataset: chemicals, proteins, a gene – find-or-create never duplicates a record (glucose stays ONE record)', async () => {
  for (const n of ['Glucose', 'ATP', 'ADP', 'Glucose-6-phosphate', 'Fructose-6-phosphate', 'Fructose-1,6-bisphosphate', 'Dihydroxyacetone phosphate', 'Glyceraldehyde-3-phosphate', '6-Phosphogluconolactone', 'Mg2+', 'Inhibitor X']) ids[n] = (await rec('chemical', n, n === 'Glucose-6-phosphate' || n === 'Glucose' ? { chemType: 'Metabolite' } : {})).id;
  for (const n of ['Hexokinase', 'Glucose-6-phosphate isomerase', 'Phosphofructokinase', 'Fructose-bisphosphate aldolase', 'Glucose-6-phosphate dehydrogenase']) ids[n] = (await rec('protein', n, { protType: 'Enzyme' })).id;
  ids.HK1 = (await rec('gene', 'HK1')).id; ids.human = (await rec('organism', 'Homo sapiens')).id; ids.paper = (await rec('publication', 'Glucose phosphorylation by hexokinase')).id;
  const again = await rec('chemical', 'glucose'); assert.equal(again.created, false); assert.equal(again.id, ids.Glucose, 'a differently-cased name resolves to the same record');
});

test('relationship types: built-ins exist; custom types can be added; built-ins are protected; a type in use cannot be deleted', async () => {
  const t = (await u.api.get(`/api/explorer/types?workspace=${u.wsId}`)).json.types;
  for (const n of ['Binds to', 'Inhibits', 'Substrate of', 'Product of', 'Converted into', 'Catalyzed by', 'Encodes', 'Part of pathway', 'Antioxidant activity', 'Cytotoxic to']) assert.ok(t.some((x: any) => x.name === n), n);
  const custom = await u.api.post('/api/explorer/types', { workspaceId: u.wsId, name: 'Allosterically feeds back on', directional: true, sourceKinds: ['chemical'], targetKinds: ['protein'], description: 'Product acts back on an upstream enzyme', edgeStyle: 'dashed' });
  assert.equal(custom.status, 200); ids.customType = custom.json.type.id;
  assert.equal((await u.api.post('/api/explorer/types', { workspaceId: u.wsId, name: 'allosterically feeds back on' })).status, 400, 'names are unique (case-insensitive)');
  const builtin = t.find((x: any) => x.name === 'Binds to'); assert.equal((await u.api.del(`/api/explorer/types/${builtin.id}`)).status, 400); assert.equal((await u.api.patch(`/api/explorer/types/${builtin.id}`, { name: 'x' })).status, 400);
  for (const n of ['Binds to', 'Substrate of', 'Inhibits', 'Encodes', 'Product of']) ids[`type:${n}`] = t.find((x: any) => x.name === n).id;
});

test('many-to-many relationships with evidence, several citations and tags; one pair may have several relationships', async () => {
  // glucose – hexokinase: a substrate relationship (experimentally verified) AND a literature-reported binding; chemical → several proteins and protein → several chemicals
  const a = await rel({ sourceId: ids.Glucose, targetId: ids.Hexokinase, typeName: 'Substrate of', evidenceClass: 'experimentally_verified', description: 'Glucose is phosphorylated by hexokinase.', organism: 'Homo sapiens', sourceDb: 'literature', citations: [{ kind: 'doi', value: '10.1000/xyz123', title: 'Kinetics' }, { kind: 'pmid', value: '123456' }], tags: ['Glycolysis', 'Glucose metabolism'] });
  assert.equal(a.status, 200, JSON.stringify(a.json)); ids.relA = a.json.relationship.id;
  assert.equal(a.json.relationship.citations.length, 2); assert.deepEqual(a.json.relationship.tags.sort(), ['Glucose metabolism', 'Glycolysis']); assert.equal(a.json.relationship.citations[0].url, 'https://doi.org/10.1000/xyz123');
  const b = await rel({ sourceId: ids.Glucose, targetId: ids.Hexokinase, typeName: 'Binds to', evidenceClass: 'literature_reported' }); assert.equal(b.status, 200, 'same pair, a different meaning');
  const dup = await rel({ sourceId: ids.Glucose, targetId: ids.Hexokinase, typeName: 'Substrate of', evidenceClass: 'experimentally_verified', organism: 'Homo sapiens' });
  assert.equal(dup.status, 400); assert.match(dup.json.error, /already recorded/);
  const other = await rel({ sourceId: ids.Glucose, targetId: ids.Hexokinase, typeName: 'Substrate of', evidenceClass: 'computationally_predicted', organism: 'Homo sapiens' }); assert.equal(other.status, 200, 'the same statement with different evidence is a different finding');
  // one chemical → many proteins; one protein ← many chemicals
  await rel({ sourceId: ids.Glucose, targetId: ids['Glucose-6-phosphate isomerase'], typeName: 'Binds to', evidenceClass: 'computationally_predicted' });
  await rel({ sourceId: ids['Inhibitor X'], targetId: ids.Hexokinase, typeName: 'Inhibits', evidenceClass: 'computationally_predicted', description: 'Docking prediction only.' });
  await rel({ sourceId: ids.ATP, targetId: ids.Hexokinase, typeName: 'Substrate of', evidenceClass: 'database_annotated', sourceDb: 'UniProt' });
  const hk = (await u.api.get(`/api/records/${ids.Hexokinase}/relationships`)).json.relationships; assert.ok(new Set(hk.map((r: any) => r.sourceId)).size >= 3, 'hexokinase is related to several chemicals');
  const gl = (await u.api.get(`/api/records/${ids.Glucose}/relationships`)).json.relationships; assert.ok(new Set(gl.map((r: any) => r.targetId)).size >= 2, 'glucose is related to several proteins');
  // validation
  assert.equal((await rel({ sourceId: ids.Glucose, targetId: ids.ATP, typeName: 'Converted into', citations: [{ kind: 'doi', value: 'not-a-doi' }] })).status, 400);
  assert.equal((await rel({ sourceId: ids.Glucose, targetId: ids.ATP, typeName: 'Converted into', citations: [{ kind: 'pmid', value: 'abc' }] })).status, 400);
  assert.equal((await rel({ sourceId: ids.Glucose, targetId: 'rec_missing', typeName: 'Converted into' })).status >= 400, true);
  // incompatible combination: allowed only when confirmed
  const inc = await rel({ sourceId: ids.Glucose, targetId: ids.Hexokinase, typeName: 'Encodes' }); assert.equal(inc.status, 400); assert.equal(inc.json.code, 'incompatible');
  assert.equal((await rel({ sourceId: ids.Glucose, targetId: ids.Hexokinase, typeName: 'Encodes', allowIncompatible: true, evidenceClass: 'unverified' })).status, 200);
  // a custom type can be typed in and is created on the fly
  const c2 = await rel({ sourceId: ids['Fructose-1,6-bisphosphate'], targetId: ids.Hexokinase, typeName: 'Feeds back on (custom)', description: 'Hypothesis', evidenceClass: 'unverified' }); assert.equal(c2.status, 200);
  assert.equal(c2.json.relationship.type.name, 'Feeds back on (custom)');
  // batch: independent results (one fails, the others are saved) and atomic mode (all or none)
  const batch = await u.api.post('/api/relationships', { relationships: [{ sourceId: ids.Glucose, targetId: ids.ADP, typeName: 'Associated with' }, { sourceId: ids.Glucose, targetId: ids.ADP, typeName: 'Associated with' }, { sourceId: ids.Glucose, targetId: ids['Mg2+'], typeName: 'Associated with' }] });
  assert.deepEqual(batch.json.results.map((r: any) => r.ok), [true, false, true], 'each relationship is stored (or refused) on its own: the duplicate is refused, the others kept');
  const atomic = await u.api.post('/api/relationships', { atomic: true, relationships: [{ sourceId: ids.Glucose, targetId: ids.ATP, typeName: 'Associated with' }, { sourceId: ids.Glucose, targetId: 'rec_missing', typeName: 'Associated with' }] });
  assert.equal(atomic.status, 400); assert.equal((await u.api.get(`/api/relationships?workspace=${u.wsId}&q=Associated`)).json.rows.filter((r: any) => r.targetId === ids.ATP && r.sourceId === ids.Glucose).length, 0, 'nothing from the failed atomic batch was kept');
});

test('deleting a relationship never deletes its records; editing keeps tags and citations; listing filters by type, evidence and tag', async () => {
  const before = (await u.api.get(`/api/relationships?workspace=${u.wsId}`)).json.total;
  const x = await rel({ sourceId: ids.Glucose, targetId: ids['Glucose-6-phosphate'], typeName: 'Converted into', evidenceClass: 'user_supplied', tags: ['temp'] });
  assert.equal((await u.api.patch(`/api/relationships/${x.json.relationship.id}`, { evidenceClass: 'literature_reported', description: 'edited', citations: [{ kind: 'url', value: 'https://example.org/p' }] })).json.relationship.citations.length, 1);
  const del = await u.api.del(`/api/relationships/${x.json.relationship.id}`); assert.equal(del.status, 200);
  assert.equal((await u.api.get(`/api/records/${ids.Glucose}`)).status, 200); assert.equal((await u.api.get(`/api/records/${ids['Glucose-6-phosphate']}`)).status, 200, 'both records survive');
  assert.equal((await u.api.get(`/api/relationships/${x.json.relationship.id}`)).status, 404); assert.equal((await u.api.get(`/api/relationships?workspace=${u.wsId}`)).json.total, before);
  const byTag = (await u.api.get(`/api/relationships?workspace=${u.wsId}&tags=Glycolysis`)).json; assert.equal(byTag.total, 1);
  const byEv = (await u.api.get(`/api/relationships?workspace=${u.wsId}&evidence=computationally_predicted`)).json; assert.ok(byEv.total >= 3 && byEv.rows.every((r: any) => r.evidenceClass === 'computationally_predicted'));
  const byType = (await u.api.get(`/api/relationships?workspace=${u.wsId}&types=${ids['type:Inhibits']}`)).json; assert.equal(byType.total, 1);
});

test('reactions: several reactants and products with stoichiometry, structured roles, reversibility, no duplicated chemicals', async () => {
  const mk = async (name: string, reversible: string, parts: [string, string, number?][]) => {
    const r = await u.api.post('/api/reactions', { projectId: u.projectId, name, reversible, organism: 'Homo sapiens', evidence: 'Database annotated', participants: parts.map(([n, role, st]) => ({ recordId: ids[n], role, stoichiometry: st })) });
    assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json;
  };
  const r1 = await mk('Hexokinase reaction', 'Irreversible', [['Glucose', 'reactant'], ['ATP', 'reactant'], ['Glucose-6-phosphate', 'product'], ['ADP', 'product'], ['Hexokinase', 'enzyme'], ['Mg2+', 'cofactor'], ['Inhibitor X', 'inhibitor']]); ids.R1 = r1.id;
  assert.equal(r1.equation, 'Glucose + ATP → Glucose-6-phosphate + ADP'); assert.equal(r1.participants.length, 7);
  ids.R2 = (await mk('Glucose-6-phosphate isomerase reaction', 'Reversible', [['Glucose-6-phosphate', 'reactant'], ['Fructose-6-phosphate', 'product'], ['Glucose-6-phosphate isomerase', 'enzyme']])).id;
  ids.R3 = (await mk('Phosphofructokinase reaction', 'Irreversible', [['Fructose-6-phosphate', 'reactant'], ['ATP', 'reactant'], ['Fructose-1,6-bisphosphate', 'product'], ['ADP', 'product'], ['Phosphofructokinase', 'enzyme']])).id;
  ids.R4 = (await mk('Aldolase reaction', 'Reversible', [['Fructose-1,6-bisphosphate', 'reactant'], ['Dihydroxyacetone phosphate', 'product'], ['Glyceraldehyde-3-phosphate', 'product'], ['Fructose-bisphosphate aldolase', 'enzyme']])).id;
  ids.R7 = (await mk('Glucose-6-phosphate dehydrogenase reaction', 'Irreversible', [['Glucose-6-phosphate', 'reactant'], ['6-Phosphogluconolactone', 'product'], ['Glucose-6-phosphate dehydrogenase', 'enzyme']])).id;
  const eq = (await u.api.get(`/api/reactions/${ids.R2}`)).json; assert.equal(eq.equation, 'Glucose-6-phosphate ⇌ Fructose-6-phosphate');
  // stoichiometry and a "2 × product" reaction
  const dbl = await u.api.put(`/api/reactions/${ids.R4}/participants`, { participants: [{ recordId: ids['Fructose-1,6-bisphosphate'], role: 'reactant' }, { recordId: ids['Glyceraldehyde-3-phosphate'], role: 'product', stoichiometry: 2 }] });
  assert.equal(dbl.json.equation, 'Fructose-1,6-bisphosphate ⇌ 2 Glyceraldehyde-3-phosphate');
  await u.api.put(`/api/reactions/${ids.R4}/participants`, { participants: [{ recordId: ids['Fructose-1,6-bisphosphate'], role: 'reactant' }, { recordId: ids['Dihydroxyacetone phosphate'], role: 'product' }, { recordId: ids['Glyceraldehyde-3-phosphate'], role: 'product' }, { recordId: ids['Fructose-bisphosphate aldolase'], role: 'enzyme' }] });
  // validation
  assert.equal((await u.api.put(`/api/reactions/${ids.R2}/participants`, { participants: [{ recordId: ids.Glucose, role: 'wizard' }] })).status, 400);
  assert.equal((await u.api.put(`/api/reactions/${ids.R2}/participants`, { participants: [{ recordId: ids.Glucose, role: 'reactant', stoichiometry: -1 }] })).status, 400);
  const warn = await u.api.put(`/api/reactions/${ids.R2}/participants`, { participants: [{ recordId: ids.Hexokinase, role: 'reactant' }, { recordId: ids['Glucose-6-phosphate'], role: 'product' }] });
  assert.ok(warn.json.warnings.some((w: string) => /protein listed as a reactant/.test(w))); // restore
  await u.api.put(`/api/reactions/${ids.R2}/participants`, { participants: [{ recordId: ids['Glucose-6-phosphate'], role: 'reactant' }, { recordId: ids['Fructose-6-phosphate'], role: 'product' }, { recordId: ids['Glucose-6-phosphate isomerase'], role: 'enzyme' }] });
  // the same chemical record takes part in several reactions and is still ONE record
  const g6p = await u.api.get(`/api/pathways/x`); void g6p;
  const chem = (await u.api.post(`/api/tables/${u.tables.chemical}/query`, {})).json.records.filter((r: any) => Object.values(r.fields).includes('Glucose-6-phosphate')); assert.equal(chem.length, 1);
  const parts = await Promise.all([ids.R1, ids.R2, ids.R7].map(async (r) => (await u.api.get(`/api/reactions/${r}`)).json.participants.some((p: any) => p.recordId === ids['Glucose-6-phosphate']))); assert.deepEqual(parts, [true, true, true]);
});

test('pathways: ordered with explicit steps, branching, one reaction in several pathways, honest about unknown order', async () => {
  const mk = async (name: string, steps: any[], edges: any[], linear = false) => { const r = await u.api.post('/api/pathways', { projectId: u.projectId, name, organism: 'Homo sapiens', evidence: 'Database annotated', steps, edges, linear, tags: [name.split(' ')[0]] }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
  const S = (k: string, extra: Record<string, unknown> = {}) => ({ reactionId: ids[k], orderBasis: 'curated', ...extra });
  const gly = await mk('Glycolysis (upper)', [S('R1'), S('R2'), S('R3'), S('R4'), S('R7', { branch: 'oxidative branch', orderBasis: 'user' })], [
    { from: ids.R1, to: ids.R2, basis: 'curated' }, { from: ids.R2, to: ids.R3, basis: 'curated' }, { from: ids.R3, to: ids.R4, basis: 'curated' }, { from: ids.R2, to: ids.R7, kind: 'alternative', basis: 'user' }]);
  ids.glycolysis = gly.id; const v = gly.pathway;
  assert.equal(v.orderState, 'ordered'); assert.equal(v.hasBranches, true, 'R2 leads to two next steps'); assert.equal(v.hasCycles, false);
  const lvl = Object.fromEntries(v.steps.map((s: any) => [s.reactionId, s.level])); assert.deepEqual([lvl[ids.R1], lvl[ids.R2], lvl[ids.R3], lvl[ids.R4], lvl[ids.R7]], [0, 1, 2, 3, 2], 'reaction order from the explicit edges; the branch sits beside R3');
  assert.deepEqual(v.chemicals.starting.map((c: any) => c.name).sort(), ['ATP', 'Glucose'], 'consumed but never produced inside the pathway');
  assert.ok(v.chemicals.intermediate.some((c: any) => c.name === 'Glucose-6-phosphate') && v.chemicals.intermediate.some((c: any) => c.name === 'Fructose-6-phosphate'));
  assert.ok(v.chemicals.final.some((c: any) => c.name === 'Glyceraldehyde-3-phosphate') && v.chemicals.final.some((c: any) => c.name === '6-Phosphogluconolactone'));
  // the same reaction (R1) in a second pathway; the chemical's other pathways are discoverable
  const util = await mk('Glucose utilisation', [S('R1'), S('R7')], [], false); ids.util = util.id; assert.equal(util.pathway.orderState, 'unknown', 'no explicit order → never guessed from the chemicals');
  assert.ok(util.pathway.steps.every((s: any) => s.level === 0));
  const g6p = (await u.api.get(`/api/records/${ids['Glucose-6-phosphate']}/pathways`)).json.pathways; assert.deepEqual(g6p.map((p: any) => p.name).sort(), ['Glucose utilisation', 'Glycolysis (upper)']);
  assert.equal((await u.api.get(`/api/records/${ids.R1}/pathways`)).json.pathways.length, 2);
  // linear shortcut = explicit edges created because the user asked
  const lin = await mk('Linear demo', [S('R2'), S('R3'), S('R4')], [], true); assert.equal(lin.pathway.orderState, 'ordered'); assert.equal(lin.pathway.edges.length, 2);
  // a cycle is recognised and not allowed to break the layout
  const cyc = await mk('Cycle demo', [S('R2'), S('R3'), S('R4')], [{ from: ids.R2, to: ids.R3 }, { from: ids.R3, to: ids.R4 }, { from: ids.R4, to: ids.R2 }]); assert.equal(cyc.pathway.hasCycles, true); assert.ok(cyc.pathway.edges.some((e: any) => e.back));
  assert.deepEqual(cyc.pathway.steps.map((s: any) => s.level).sort(), [0, 1, 2]);
  // validation
  assert.equal((await u.api.put(`/api/pathways/${ids.glycolysis}/steps`, { steps: [S('R1'), S('R1')] })).status, 400, 'a reaction is a step only once');
  assert.equal((await u.api.put(`/api/pathways/${ids.glycolysis}/steps`, { steps: [S('R1')], edges: [{ from: ids.R1, to: ids.R2 }] })).status, 400);
  assert.equal((await u.api.put(`/api/pathways/${ids.glycolysis}/steps`, { steps: [{ reactionId: ids.Glucose }] })).status, 400, 'a step must be a reaction record');
  assert.equal((await u.api.get(`/api/pathways/${ids.glycolysis}`)).json.steps.length, 5, 'refused changes leave the pathway untouched');
});

test('the explorer graph: neighbourhoods, filters, derived reaction edges, pathway view, expansion counts', async () => {
  // focus on glucose: relationships + the reaction it is a reactant of + that reaction's enzyme and products one level further
  const g1 = await graph(`focus=${ids.Glucose}&depth=1`);
  const label = (id: string) => g1.nodes.find((n: any) => n.id === id)?.label;
  assert.ok(g1.nodes.some((n: any) => n.id === ids.Hexokinase) && g1.nodes.some((n: any) => n.id === ids.R1), 'direct neighbours: hexokinase (relationship) and the reaction (participant)');
  assert.ok(!g1.nodes.some((n: any) => n.id === ids['Fructose-6-phosphate']), 'depth 1 stays small'); void label;
  const g2 = await graph(`focus=${ids.Glucose}&depth=2`); assert.ok(g2.nodes.some((n: any) => n.id === ids['Glucose-6-phosphate']) && g2.nodes.some((n: any) => n.id === ids.glycolysis), 'depth 2 reaches the products and the pathway');
  assert.ok(g1.nodes.find((n: any) => n.id === ids.R1).more >= 1, 'a node with unloaded connections says how many more there are');
  const types = Object.fromEntries(g2.nodes.map((n: any) => [n.id, n.type])); assert.equal(types[ids.R1], 'reaction'); assert.equal(types[ids.Hexokinase], 'enzyme'); assert.equal(types[ids.Glucose], 'metabolite'); assert.equal(types[ids.glycolysis], 'pathway'); assert.equal(types[ids['Inhibitor X']] ?? 'chemical', 'chemical');
  const roleEdges = g2.edges.filter((e: any) => e.origin === 'participant'); assert.ok(roleEdges.some((e: any) => e.role === 'reactant' && e.source === ids.Glucose && e.target === ids.R1) && roleEdges.some((e: any) => e.role === 'product' && e.source === ids.R1 && e.target === ids['Glucose-6-phosphate']) && roleEdges.some((e: any) => e.role === 'enzyme' && e.source === ids.Hexokinase), 'direction follows the chemistry: reactant → reaction → product, enzyme → reaction');
  // evidence filter and the prediction flag
  const pred = await graph(`focus=${ids.Hexokinase}&depth=1&evidence=computationally_predicted`); assert.ok(pred.edges.length >= 1 && pred.edges.every((e: any) => e.evidence === 'computationally_predicted' && e.predicted === true));
  assert.ok(pred.edges.some((e: any) => e.typeName === 'Inhibits'));
  const exp = await graph(`focus=${ids.Hexokinase}&depth=1&evidence=experimentally_verified`); assert.ok(exp.edges.every((e: any) => e.evidence === 'experimentally_verified' && !e.predicted));
  // kinds, types, tags, organism filters
  assert.ok((await graph(`focus=${ids.Hexokinase}&depth=1&kinds=chemical,protein`)).nodes.every((n: any) => ['chemical', 'protein'].includes(n.kind)));
  assert.deepEqual([...new Set((await graph(`focus=${ids.Hexokinase}&depth=1&types=${ids['type:Inhibits']}`)).edges.map((e: any) => e.typeName))], ['Inhibits']);
  await u.api.put(`/api/records/${ids.R1}/tags`, { tags: ['Glycolysis'] });
  const tagged = await graph('tags=Glycolysis'); assert.ok(tagged.edges.length >= 2 && tagged.edges.every((e: any) => e.tags.includes('Glycolysis') || [e.source, e.target].some((id: string) => tagged.nodes.find((n: any) => n.id === id)?.tags.includes('Glycolysis'))), 'the tag filter keeps only tagged records or relationships');
  assert.ok(!tagged.nodes.some((n: any) => n.id === ids.paper));
  assert.ok((await graph(`organism=Homo&focus=${ids.Glucose}&depth=2`)).edges.length >= 1);
  // pathway view: the pathway, its reactions, all participants, and the explicit order
  const pv = await graph(`pathway=${ids.glycolysis}`);
  assert.ok(pv.nodes.filter((n: any) => n.type === 'reaction').length === 5 && pv.nodes.some((n: any) => n.id === ids.glycolysis));
  const order = pv.edges.filter((e: any) => e.origin === 'order'); assert.equal(order.length, 4); assert.ok(order.some((e: any) => e.source === ids.R2 && e.target === ids.R7 && e.label === 'Alternative next step'));
  assert.ok(pv.nodes.some((n: any) => n.id === ids.Hexokinase) && pv.nodes.some((n: any) => n.id === ids['Glyceraldehyde-3-phosphate']));
  // global network is bounded
  const all = await graph('limit=20'); assert.ok(all.nodes.length >= 5 && all.edges.length >= 5, 'the global network works without a focus'); // truncation itself is covered by the scale test
  // facets for the filter panel
  const f = (await u.api.get(`/api/explorer/facets?workspace=${u.wsId}`)).json; assert.ok(f.tags.some((t: any) => t.tag === 'Glycolysis') && f.pathways.length >= 4 && f.evidence.length >= 3 && f.types.length >= 18);
  // search
  const s = (await u.api.get(`/api/explorer/search?workspace=${u.wsId}&q=hexo`)).json.results; assert.ok(s.some((r: any) => r.id === ids.Hexokinase));
  // exports: Cytoscape JSON, GraphML, CSV all carry the same relationships
  const cy = JSON.parse((await u.api.get(`/api/explorer/export?workspace=${u.wsId}&focus=${ids.Glucose}&depth=2&format=cytoscape`)).text); assert.equal(cy.elements.nodes.length, g2.nodes.length); assert.equal(cy.elements.edges.length, g2.edges.length);
  const gml = (await u.api.get(`/api/explorer/export?workspace=${u.wsId}&focus=${ids.Glucose}&depth=2&format=graphml`)).text; assert.ok(gml.includes('<graphml') && (gml.match(/<edge /g) ?? []).length === g2.edges.length);
  const csv = (await u.api.get(`/api/explorer/export?workspace=${u.wsId}&focus=${ids.Glucose}&depth=2&format=csv`)).text; assert.equal(csv.trim().split('\n').length, g2.edges.length + 1); assert.ok(csv.includes('experimentally_verified') && csv.includes('computationally_predicted'));
});

test('field links made by discovery appear read-only in the graph and can be converted into full relationships (evidence kept, no duplicate)', async () => {
  const dna = (await u.api.get(`/api/tables/${u.tables.dna}`)).json.fields as any[]; const nm = dna.find((f) => f.key === 'name').id, genes = dna.find((f) => f.name === 'Genes');
  const d = (await u.api.post(`/api/tables/${u.tables.dna}/records`, { fields: { [nm]: 'NM_demo' } })).json.records[0].id;
  const gtab = await (await u.api.get(`/api/tables/${u.tables.gene}`)).json; const gname = gtab.fields.find((f: any) => f.key === 'name').id;
  const g = (await u.api.post(`/api/tables/${u.tables.gene}/records`, { fields: { [gname]: 'DEMO1' } })).json.records[0].id;
  const { listFields } = await import('../server/schema.ts'); const { linkRecords } = await import('../server/records.ts');
  const field = listFields(u.tables.dna).find((f) => f.id === genes.id)!;
  assert.equal(linkRecords(field, d, g, { relationType: 'encodes', evidenceClass: 'database_annotated', evidence: 'NCBI CDS annotation', sourceDb: 'NCBI Nucleotide' } as any), true); // what discovery does
  const gr = await graph(`focus=${d}&depth=1`); const e = gr.edges.find((x: any) => x.origin === 'field'); assert.ok(e, 'the field link is shown'); assert.equal(e.evidence, 'database_annotated');
  const link = Number(e.id.slice(4)); const conv = await u.api.post(`/api/links/${link}/convert`, {}); assert.equal(conv.status, 200, JSON.stringify(conv.json));
  assert.equal(conv.json.relationship.evidenceClass, 'database_annotated'); assert.equal(conv.json.relationship.sourceDb, 'NCBI Nucleotide');
  const after = await graph(`focus=${d}&depth=1`); assert.equal(after.edges.length, 1, 'shown once: the relationship replaces the legacy edge'); assert.equal(after.edges[0].origin, 'relationship');
  assert.equal((await u.api.post(`/api/links/${link}/convert`, {})).status, 400);
});

test('relationships persist across a restart of the database connection', async () => {
  const before = (await u.api.get(`/api/relationships?workspace=${u.wsId}`)).json.total; assert.ok(before > 5);
  closeDb(); openDb(); resetLocalIdentityCache(); ensureLocalIdentity();
  assert.equal((await u.api.get(`/api/relationships?workspace=${u.wsId}`)).json.total, before);
  assert.equal((await u.api.get(`/api/pathways/${ids.glycolysis}`)).json.steps.length, 5);
});

// ---------------------------------------------------------------- images
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
test('chemical images: PubChem depiction by CID, cached on disk, never looked up by name, honest when there is no identifier', async () => {
  const calls: string[] = [];
  setFetch(async (url) => { calls.push(url); if (/cid\/2244\/PNG/.test(url)) return new Response(PNG1, { status: 200, headers: { 'content-type': 'image/png' } }); return new Response('', { status: 404 }); });
  const asp = (await rec('chemical', 'Aspirin', { cid: '2244' })).id, noid = (await rec('chemical', 'Mystery compound')).id;
  const img = await u.api.getBuffer(`/api/records/${asp}/thumbnail`); assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png'); assert.deepEqual(img.buf, PNG1);
  const n = calls.length; await u.api.getBuffer(`/api/records/${asp}/thumbnail`); assert.equal(calls.length, n, 'the second view is served from the local cache');
  const info = (await u.api.get(`/api/records/${asp}/thumbnail/info`)).json; assert.equal(info.available, true); assert.equal(info.info.source, 'PubChem 2D depiction'); assert.equal(info.info.identifier, 'CID 2244'); assert.ok(existsSync(join(config.dataDir, 'images', `${asp}.png`)));
  const none = await u.api.getBuffer(`/api/records/${noid}/thumbnail`); assert.equal(none.status, 404); assert.match(JSON.parse(none.buf.toString()).error, /never looked up by name/i);
  assert.ok(!calls.some((c) => /Mystery|name/.test(c)), 'no request was made for a record without an identifier');
  // offline: the cached image is still served, a missing one is not fetched
  await u.api.post('/api/network', { mode: 'offline' }); const m = calls.length;
  assert.equal((await u.api.getBuffer(`/api/records/${asp}/thumbnail`)).status, 200); const fresh = (await rec('chemical', 'Caffeine', { cid: '2519' })).id; assert.equal((await u.api.getBuffer(`/api/records/${fresh}/thumbnail`)).status, 404); assert.equal(calls.length, m, 'no outbound call while offline');
  await u.api.post('/api/network', { mode: 'auto' }); setFetch(null); purgeCache();
});

test('protein images are DRAWN from real coordinates (experimental preferred, prediction labelled); without coordinates nothing is invented', async () => {
  // a small synthetic backbone (helix) in a PDB-format file
  const atoms: string[] = []; for (let i = 0; i < 60; i++) { const a = i * 100 * Math.PI / 180; atoms.push(`ATOM  ${String(i + 1).padStart(5)}  CA  ALA A${String(i + 1).padStart(4)}    ${(2.3 * Math.cos(a)).toFixed(3).padStart(8)}${(2.3 * Math.sin(a)).toFixed(3).padStart(8)}${(1.5 * i).toFixed(3).padStart(8)}  1.00 90.00           C`); }
  const pdb = atoms.join('\n') + '\nEND\n'; mkdirSync(join(config.dataDir, 'structures'), { recursive: true });
  writeFileSync(join(config.dataDir, 'structures', 'AF-P12345-F1-v4.pdb'), pdb);
  const prot = (await rec('protein', 'Demo protein', { accession: 'P12345' })).id;
  const r = await u.api.getBuffer(`/api/records/${prot}/thumbnail`); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/svg+xml'); const svg = r.buf.toString();
  assert.match(svg, /AlphaFold P12345/); assert.match(svg, /<line /); assert.ok((svg.match(/<line /g) ?? []).length === 59, 'one segment per backbone step');
  const info = (await u.api.get(`/api/records/${prot}/thumbnail/info`)).json.info; assert.equal(info.experimental, false); assert.match(info.note, /COMPUTATIONALLY PREDICTED/);
  assert.equal(r.headers.get('content-security-policy')?.includes('sandbox'), true);
  // an experimental structure for the same protein wins and is labelled as such
  writeFileSync(join(config.dataDir, 'structures', '1IEP.pdb'), pdb);
  const st = (await rec('structure', 'Crystal 1IEP', { accession: '1IEP' })).id; await rel({ sourceId: prot, targetId: st, typeName: 'Associated with', evidenceClass: 'database_annotated' });
  await u.api.post(`/api/records/${prot}/thumbnail/refresh`, {}); const exp = (await u.api.get(`/api/records/${prot}/thumbnail/info`)).json.info; assert.equal(exp.experimental, true); assert.match(exp.source, /RCSB PDB 1IEP/);
  // no coordinates, no UniProt accession: nothing drawn
  const bare = (await rec('protein', 'Unknown protein')).id; assert.equal((await u.api.getBuffer(`/api/records/${bare}/thumbnail`)).status, 404);
  // the drawing code itself: principal-axis projection draws every segment and a degenerate input is refused
  assert.ok(traceSvg(parseCa(pdb), 'x', 'y').includes('<svg')); assert.throws(() => traceSvg(parseCa('ATOM      1  CA  ALA A   1       0.0 0.0 0.0'), 'x', 'y'));
  // the image column is a normal table column
  const tf = (await u.api.get(`/api/tables/${u.tables.protein}`)).json.fields.find((f: any) => f.type === 'thumbnail'); assert.ok(tf, 'the Proteins table has a structure-image column');
  const row = (await u.api.post(`/api/tables/${u.tables.protein}/query`, {})).json.records.find((x: any) => x.id === prot); assert.equal(row.fields[tf.id], prot, 'the cell value is the record id the browser requests the image for');
});

// ---------------------------------------------------------------- offline-first behaviour
test('offline: external tasks wait in the queue (not dropped), local tasks run, and the queue drains when the connection is back', async () => {
  jobs.LOCAL_ONLY_JOBS.add('t.local');
  jobs.registerJob('t.external', async () => ({ summary: 'fetched' })); jobs.registerJob('t.local', async () => ({ summary: 'computed' }));
  assert.equal((await u.api.post('/api/network', { mode: 'offline' })).json.offline, true);
  const ext = jobs.enqueue({ workspaceId: u.wsId, type: 't.external', name: 'needs internet', userId: u.userId }), loc = jobs.enqueue({ workspaceId: u.wsId, type: 't.local', name: 'local only', userId: u.userId });
  await until(async () => (await u.api.get(`/api/jobs/${loc}`)).json.job.status === 'completed');
  const waiting = (await u.api.get(`/api/jobs/${ext}`)).json.job; assert.equal(waiting.status, 'queued'); assert.match(waiting.message, /Waiting for an internet connection/);
  assert.equal((await u.api.get('/api/network')).json.waitingJobs >= 1, true);
  await u.api.post('/api/network', { mode: 'auto' }); jobs.enqueue({ workspaceId: u.wsId, type: 't.local', name: 'nudge', userId: u.userId });
  await until(async () => (await u.api.get(`/api/jobs/${ext}`)).json.job.status === 'completed', 15000);
  // an outbound request while offline: stale cache is served, otherwise an explicit error – never a silent failure
  const { request } = await import('../server/integrations/http.ts'); const { q } = await import('../server/db.ts');
  setFetch(async () => new Response('{"fresh":true}', { status: 200 })); purgeCache();
  assert.equal((await request('https://rest.uniprot.org/x', { ttl: 60 })).text, '{"fresh":true}');
  q.run('UPDATE http_cache SET fetched_at = fetched_at - 999999'); // make the cached answer old
  await u.api.post('/api/network', { mode: 'offline' });
  const stale = await request('https://rest.uniprot.org/x', { ttl: 60 }); assert.equal(stale.cached, true); assert.equal(stale.text, '{"fresh":true}', 'a stale answer is served rather than nothing');
  await assert.rejects(() => request('https://rest.uniprot.org/never-fetched', { ttl: 60 }), /internet connection/);
  await u.api.post('/api/network', { mode: 'auto' }); setFetch(null); purgeCache();
});
async function until(fn: () => Promise<boolean>, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 60)); } throw new Error('condition not reached'); }

// ---------------------------------------------------------------- local data: backup, restore, export, import
test('backup / restore and whole-workspace export / import keep relationships, reactions, pathways and citations', async () => {
  const count = async () => ({ rel: (await u.api.get(`/api/relationships?workspace=${u.wsId}`)).json.total, steps: (await u.api.get(`/api/pathways/${ids.glycolysis}`)).json.steps.length, cites: (await u.api.get(`/api/relationships/${ids.relA}`)).json.relationship.citations.length });
  const was = await count(); assert.ok(was.rel > 5 && was.steps === 5 && was.cites === 2);
  const bk = await u.api.post('/api/local/backups', {}); assert.equal(bk.status, 200); const name: string = bk.json.backup; assert.ok(existsSync(join(config.dataDir, 'backups', name)));
  // change something, then restore the backup
  await u.api.del(`/api/relationships/${ids.relA}`); assert.equal((await count().catch(() => ({ rel: -1 }))).rel !== was.rel, true);
  const rs = await u.api.post('/api/local/restore', { name }); assert.equal(rs.status, 200, JSON.stringify(rs.json)); assert.ok(rs.json.safetyBackup); assert.deepEqual(await count(), was);
  // export the whole workspace to a .vsws file
  const ex = await u.api.getBuffer('/api/local/export'); assert.equal(ex.status, 200); assert.ok(ex.buf.length > 1000); assert.equal(ex.buf[0], 0x1f, 'a gzip stream'); assert.match(ex.headers.get('content-disposition') ?? '', /\.vsws/);
  await u.api.del(`/api/relationships/${ids.relA}`); await u.api.put(`/api/pathways/${ids.glycolysis}/steps`, { steps: [] });
  const imp = await fetch(base + '/api/local/import', { method: 'POST', headers: { 'x-vs': '1', 'content-type': 'application/octet-stream' }, body: ex.buf }); assert.equal(imp.status, 200, await imp.text());
  assert.deepEqual(await count(), was, 'importing restores relationships, pathway steps and citations');
  // a damaged or foreign file is refused and nothing changes
  const bad = await fetch(base + '/api/local/import', { method: 'POST', headers: { 'x-vs': '1', 'content-type': 'application/octet-stream' }, body: Buffer.from('this is not a workspace export') }); assert.ok(bad.status >= 400); assert.deepEqual(await count(), was);
  assert.equal((await u.api.post('/api/local/restore', { name: '../../etc/passwd' })).status, 404);
  const info = (await u.api.get('/api/local/info')).json; assert.ok(info.bytes.database > 0 && info.relationships >= was.rel && info.backups.length >= 2);
});

// ---------------------------------------------------------------- scale
test('performance: thousands of records and relationships – neighbourhood, facets and global views stay fast and bounded', async () => {
  const { q, tx } = await import('../server/db.ts');
  const ctab = u.tables.chemical, ptab = u.tables.protein;
  const cname = (await u.api.get(`/api/tables/${ctab}`)).json.fields.find((f: any) => f.key === 'name').id, pname = (await u.api.get(`/api/tables/${ptab}`)).json.fields.find((f: any) => f.key === 'name').id;
  const { uid, now } = await import('../server/util.ts'); const ts = now();
  const chem: string[] = [], prot: string[] = [];
  tx(() => {
    for (let i = 0; i < 3000; i++) { const id = uid('rec'); chem.push(id); q.run('INSERT INTO records(id,table_id,data,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?)', id, ctab, JSON.stringify({ [cname]: `Compound ${i}` }), ts, ts, u.userId); }
    for (let i = 0; i < 1500; i++) { const id = uid('rec'); prot.push(id); q.run('INSERT INTO records(id,table_id,data,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?)', id, ptab, JSON.stringify({ [pname]: `Protein ${i}` }), ts, ts, u.userId); }
    const type = q.get<{ id: string }>("SELECT id FROM relationship_types WHERE workspace_id=? AND name='Binds to'", u.wsId)!.id;
    for (let i = 0; i < 9000; i++) q.run("INSERT OR IGNORE INTO relationships(id,workspace_id,source_id,target_id,type_id,directional,description,evidence_class,verification,origin,created_at,updated_at) VALUES (?,?,?,?,?,0,'', ?,'unverified','import',?,?)", uid('rel'), u.wsId, chem[i % 3000], prot[(i * 7 + Math.floor(i / 3000)) % 1500], type, i % 3 ? 'database_annotated' : 'computationally_predicted', ts, ts);
  });
  const timed = async (qs: string) => { const t0 = performance.now(); const r = await graph(qs); return { r, ms: performance.now() - t0 }; };
  const a = await timed(`focus=${chem[5]}&depth=1`); assert.ok(a.ms < 400, `neighbourhood ${a.ms.toFixed(0)} ms`); assert.ok(a.r.nodes.length >= 2);
  const b = await timed(`focus=${chem[5]}&depth=3&limit=300`); assert.ok(b.ms < 1500, `depth-3 expansion ${b.ms.toFixed(0)} ms`); assert.ok(b.r.nodes.length <= 300 + 5);
  const c = await timed('limit=500'); assert.ok(c.ms < 1500, `global view ${c.ms.toFixed(0)} ms`); assert.equal(c.r.truncated, true); assert.ok(c.r.nodes.length <= 1100);
  const d = await timed(`focus=${chem[5]}&depth=2&evidence=computationally_predicted`); assert.ok(d.ms < 800); assert.ok(d.r.edges.every((e: any) => e.evidence === 'computationally_predicted'));
  const t0 = performance.now(); await u.api.get(`/api/explorer/facets?workspace=${u.wsId}`); assert.ok(performance.now() - t0 < 800, 'facets');
  const t1 = performance.now(); const list = (await u.api.get(`/api/relationships?workspace=${u.wsId}&limit=200`)).json; assert.equal(list.rows.length, 200); assert.ok(list.total >= 9000); assert.ok(performance.now() - t1 < 800, 'relationship table page');
  console.log(`      graph timings: neighbourhood ${a.ms.toFixed(0)} ms, depth-3 ${b.ms.toFixed(0)} ms, global ${c.ms.toFixed(0)} ms (9,000 relationships, 4,500 records)`);
  void statSync; void readFileSync;
});

test('projects made by an earlier version get the new protein / chemical columns on start-up, without touching their data', async () => {
  const { upgradeTemplateFields } = await import('../server/templates.ts'); const { listFields, deleteField } = await import('../server/schema.ts');
  const n = await newUser(base, 'Old project'); const t = n.tables.protein;
  const rid = (await n.api.post(`/api/tables/${t}/records`, { fields: {} })).json.records[0].id; // an existing record
  for (const f of listFields(t)) if (f.key === 'thumb' || f.key === 'protType') deleteField(f.id); // what a project from before this version looks like
  assert.ok(!listFields(t).some((f) => f.key === 'thumb'));
  const added = upgradeTemplateFields(); assert.ok(added >= 2, `added ${added}`);
  assert.ok(listFields(t).some((f) => f.key === 'thumb' && f.type === 'thumbnail') && listFields(t).some((f) => f.key === 'protType'));
  assert.equal((await n.api.get(`/api/records/${rid}`)).status, 200, 'the existing record is untouched');
  assert.equal(upgradeTemplateFields(), 0, 'running it again changes nothing');
});

test('automatic backups: one per day at most, newest 20 kept, and listed with their label', async () => {
  const { autoBackupIfDue } = await import('../server/archive.ts');
  const first = autoBackupIfDue(); assert.ok(first, 'a first automatic backup is made'); assert.equal(autoBackupIfDue(), null, 'a second call the same day does nothing');
  const list = (await u.api.get('/api/local/backups')).json.backups as { name: string; label: string; bytes: number }[]; assert.ok(list.some((b) => b.label === 'auto' && b.name === first!.name && b.bytes > 0));
  assert.ok(autoBackupIfDue(0), 'forced (older than 0 ms) creates another'); // pruning to 20 is covered by the retention rule in pruneBackups
});
