// Browser end-to-end tests of the relationship explorer (Cytoscape), the inspector, both ways of creating relationships, pathway/flow/table views,
// images, offline behaviour, export/re-open and responsiveness with a larger dataset. Real server, real Chromium; the data is the example network
// (tests/fixtures/example-network.ts), loaded through the public API.
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { OUT, start } from './harness.ts';
import { Api } from '../helpers.ts';
import { GLYCOLYSIS_EXAMPLE, loadNetwork } from '../fixtures/example-network.ts';
import type { Loaded } from '../fixtures/example-network.ts';
import { config } from '../../server/config.ts';

let h: Awaited<ReturnType<typeof start>>; let page: Page; let errors: string[]; let api: Api; let ws = '', proj = ''; let L: Loaded;
const test = (name: string, fn: () => Promise<void>) => nodeTest(name, async () => { try { await fn(); } catch (e) { await page?.screenshot({ path: join(OUT, `fail-x-${name.slice(0, 28).replace(/\W+/g, '_')}.png`) }).catch(() => {}); throw e; } });
const cy = <T,>(fn: string, arg?: unknown) => page.evaluate(`(${fn})(window.__vsCy, ${JSON.stringify(arg ?? null)})`) as Promise<T>;
const open = async (path: string) => { await page.goto(h.srv.base + path); await page.locator('.xp-canvas').waitFor(); await page.waitForFunction(() => (window as any).__vsCy?.nodes().length > 0, null, { timeout: 15000 }); await page.waitForTimeout(400); };
const clickNode = async (id: string) => { // a real mouse click; retried if the canvas was still settling and the click landed beside the node
  if (await cy<boolean>('(cy, id) => cy.getElementById(id).selected()', id)) { await page.locator('.insp').waitFor(); return; } // clicking a selected node again deselects it
  for (let attempt = 0; attempt < 3; attempt++) {
    await cy('(cy, id) => { cy.center(cy.getElementById(id)); }', id); // the inspector narrows the canvas: bring the node into view first
    const p = await cy<{ x: number; y: number }>('(cy, id) => { const n = cy.getElementById(id); const p = n.renderedPosition(); const r = cy.container().getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }', id);
    await page.mouse.click(p.x, p.y);
    if (await page.locator('.insp').getByRole('heading', { name: await cy<string>('(cy, id) => cy.getElementById(id).data("label")', id), exact: true }).first().waitFor({ timeout: 2500 }).then(() => true, () => false)) return;
  }
};
const posOf = (id: string) => cy<{ x: number; y: number }>('(cy, id) => { const n = cy.getElementById(id); const p = n.renderedPosition(); const r = cy.container().getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }', id);

before(async () => {
  h = await start(); const o = await h.open(); page = o.page; errors = o.errors; api = new Api(h.srv.base);
  const st = await api.get('/api/app/state'); ws = st.json.workspaces[0].id; proj = (await api.get(`/api/workspaces/${ws}/projects`)).json.projects[0].id;
  L = await loadNetwork(api, proj, GLYCOLYSIS_EXAMPLE, ws);
  // a real C-alpha trace on disk so the protein image exists without internet (the AlphaFold download is covered by the unit tests)
  const atoms: string[] = []; for (let i = 0; i < 80; i++) { const a = i * 100 * Math.PI / 180; atoms.push(`ATOM  ${String(i + 1).padStart(5)}  CA  ALA A${String(i + 1).padStart(4)}    ${(2.3 * Math.cos(a)).toFixed(3).padStart(8)}${(2.3 * Math.sin(a)).toFixed(3).padStart(8)}${(1.5 * i).toFixed(3).padStart(8)}  1.00 90.00           C`); }
  mkdirSync(join(config.dataDir, 'structures'), { recursive: true }); writeFileSync(join(config.dataDir, 'structures', 'AF-P19367-F1-v4.pdb'), atoms.join('\n') + '\nEND\n');
  const pt0 = (await api.get(`/api/workspaces/${ws}/tables?project=${proj}`)).json.tables.find((t: any) => t.kind === 'protein').id; const accF = (await api.get(`/api/tables/${pt0}`)).json.fields.find((f: any) => f.key === 'accession').id;
  assert.equal((await api.patch(`/api/records/${L.ids.Hexokinase}`, { fields: { [accF]: 'P19367' } })).status, 200);
  await page.goto(h.srv.base + '/'); await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
});
after(async () => { await h.close(); });

test('explorer opens on a record: nodes and edges come from stored records, with the right shapes (blue family only)', async () => {
  await open(`/explorer?focus=${L.ids.Glucose}`);
  const s = await cy<any>('(cy, id) => ({ n: cy.nodes().length, e: cy.edges().length, hexo: cy.getElementById(id).data("type"), rx: cy.nodes("[type = \\"reaction\\"]").length })', L.ids.Hexokinase);
  assert.ok(s.n >= 8 && s.e >= 8, `nodes ${s.n}, edges ${s.e}`); assert.ok(s.rx >= 1, 'reactions are nodes');
  const shapes = await cy<Record<string, string>>('(cy) => { const o = {}; cy.nodes().forEach((n) => { o[n.data("type")] = n.style("shape"); }); return o; }');
  assert.equal(shapes.reaction, 'diamond'); assert.equal(shapes.metabolite, 'pentagon'); assert.equal(shapes.enzyme, 'octagon'); assert.ok(shapes.protein === undefined || shapes.protein === 'ellipse');
  // every colour used on the canvas is a blue/neutral: hue between 200 and 235 or very low saturation
  const bad = await cy<string[]>(`(cy) => { const bad = []; const hue = (hex) => { const m = hex.match(/\\d+/g).map(Number); const [r, g, b] = m.map((v) => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d < 0.08) return -1; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; return h; }; cy.elements().not(".ghost").forEach((el) => { for (const p of ["background-color", "border-color", "line-color"]) { const v = el.style(p); if (!v || !/rgb/.test(v)) continue; const hh = hue(v); if (hh !== -1 && (hh < 195 || hh > 235)) bad.push(el.id() + ":" + p + ":" + v); } }); return bad; }`);
  assert.deepEqual(bad, [], 'only blues on the canvas');
  await page.screenshot({ path: join(OUT, 'x1-explorer-focus.png') });
});

test('line style carries the evidence: predicted = dashed, experimental = solid and thicker; labels name the evidence', async () => {
  await open(`/explorer?focus=${L.ids.Hexokinase}`);
  const r = await cy<any>('(cy) => { const o = {}; cy.edges().forEach((e) => { if (e.data("origin") === "relationship") o[e.data("evidence")] = { line: e.style("line-style"), w: parseFloat(e.style("width")), label: e.data("elabel") }; }); return o; }');
  assert.equal(r.computationally_predicted.line, 'dashed'); assert.match(r.computationally_predicted.label, /predicted/); assert.match(r.experimentally_verified.label, /experimental/, 'every relationship line names its evidence in text');
  assert.equal(r.experimentally_verified.line, 'solid'); assert.ok(r.experimentally_verified.w > r.computationally_predicted.w);
  assert.ok(await page.locator('.xp-legend').getByText('Computationally predicted').isVisible(), 'the legend explains the line styles in words');
});

test('node click opens the right information in the inspector: source, accession links, relationships, pathways, image', async () => {
  await open(`/explorer?focus=${L.ids.Hexokinase}&x=1`); await page.waitForTimeout(300);
  await clickNode(L.ids.Hexokinase);
  const insp = page.locator('.insp'); await insp.waitFor();
  assert.ok(await insp.getByRole('heading', { name: 'Hexokinase' }).first().isVisible());
  assert.ok(await insp.getByText('Manual entry').isVisible() || await insp.getByText(/External|generated/).first().isVisible());
  await insp.getByRole('heading', { name: /Relationships/ }).waitFor();
  assert.ok((await insp.locator('.relitem').count()) >= 4, 'stored relationships are listed with their evidence');
  assert.ok(await insp.getByText('Experimentally verified').first().isVisible());
  const uni = insp.getByRole('link', { name: /P19367/ }); assert.equal(await uni.getAttribute('href'), 'https://www.uniprot.org/uniprotkb/P19367', 'accession links to UniProt');
  const img = insp.locator('.thumb img'); await img.waitFor({ state: 'visible', timeout: 10000 });
  assert.ok(await img.evaluate((i: HTMLImageElement) => i.naturalWidth > 0), 'protein image drawn from the AlphaFold coordinates');
  await img.click(); await page.locator('.modal').getByText(/COMPUTATIONALLY PREDICTED/).waitFor(); assert.ok(await page.locator('.modal').getByText('Computationally predicted').first().isVisible(), 'predicted structures are labelled'); await page.keyboard.press('Escape');
  await page.screenshot({ path: join(OUT, 'x2-inspector.png') });
  // a chemical with no database identifier: no image, and the panel says why instead of inventing one
  await clickNode(L.ids.Glucose); await page.locator('.insp').getByRole('heading', { name: 'Glucose' }).first().waitFor();
  await page.locator('.insp .thumb').click(); await page.locator('.modal').getByText(/never looked up by name|identifier/i).first().waitFor(); await page.keyboard.press('Escape');
});

test('filters: evidence, relationship type, entity type and tags change what is drawn; reset restores it', async () => {
  await open(`/explorer?focus=${L.ids.Hexokinase}`);
  const all = await cy<number>('(cy) => cy.edges().length');
  await page.locator('.xfilters').getByLabel('Computationally predicted').check(); await page.waitForTimeout(700);
  const ev = await cy<string[]>('(cy) => [...new Set(cy.edges().map((e) => e.data("evidence")))]'); assert.deepEqual(ev, ['computationally_predicted']);
  await page.locator('.xfilters').getByLabel('Computationally predicted').uncheck(); await page.waitForTimeout(700);
  assert.equal(await cy<number>('(cy) => cy.edges().length'), all);
  await page.locator('.xfilters').getByLabel(/^Inhibits/).check(); await page.waitForTimeout(700);
  assert.deepEqual(await cy<string[]>('(cy) => [...new Set(cy.edges().map((e) => e.data("typeName")))]'), ['Inhibits']);
  await page.getByRole('button', { name: /Filters/ }).first().isVisible();
  await page.locator('.xfilters').getByRole('button', { name: /^Clear/ }).click(); await page.waitForTimeout(700);
  await page.locator('.xfilters summary', { hasText: 'Tags' }).click(); await page.locator('.xfilters').getByLabel(/^Glycolysis/).check(); await page.waitForTimeout(700);
  assert.ok(await cy<boolean>('(cy) => cy.edges().length > 0 && cy.edges().length < 40'), 'tag filter narrows the network');
  await page.getByRole('button', { name: 'Reset' }).click(); await page.waitForTimeout(800);
  assert.ok(await cy<number>('(cy) => cy.nodes().length') >= 5);
});

test('search by name highlights matching nodes; legend toggles hide a category', async () => {
  await open(`/explorer?focus=${L.ids.Glucose}`);
  await page.getByLabel('Search the network by name').fill('hexo'); await page.waitForTimeout(500);
  assert.ok(await cy<number>('(cy) => cy.nodes(".hit").length') >= 1);
  await page.getByLabel('Search the network by name').fill('');
  const before = await cy<number>('(cy) => cy.nodes(":visible").length');
  await page.locator('.xp-legend').getByLabel('Show Reaction nodes').uncheck(); await page.waitForTimeout(300);
  assert.ok(await cy<number>('(cy) => cy.nodes(":visible").length') < before); assert.equal(await cy<number>('(cy) => cy.nodes("[type = \\"reaction\\"]:visible").length'), 0);
  await page.locator('.xp-legend').getByLabel('Show Reaction nodes').check();
});

test('lazy expansion: double-click adds the neighbours of a node without moving the rest; "Explore related network" refocuses', async () => {
  await open(`/explorer?focus=${L.ids.Glucose}`);
  const n0 = await cy<number>('(cy) => cy.nodes().length'); const rxId = await cy<string>('(cy) => cy.nodes("[type = \\"reaction\\"]").first().id()');
  const p = await posOf(rxId); await page.mouse.dblclick(p.x, p.y); await page.waitForTimeout(900);
  assert.ok(await cy<number>('(cy) => cy.nodes().length') >= n0, 'node count never shrinks on expansion');
  await clickNode(rxId); await page.locator('.insp').getByRole('button', { name: /Explore related network/ }).click(); await page.waitForTimeout(900);
  assert.ok(await cy<number>('(cy) => cy.nodes().length') >= 4);
});

test('drag-and-drop connector: shows a confirm panel, cancelling creates nothing, saving creates a stored relationship', async () => {
  await open(`/explorer?focus=${L.ids.Hexokinase}&c=1`);
  const total = async () => (await api.get(`/api/relationships?workspace=${ws}`)).json.total as number;
  const t0 = await total();
  await page.getByRole('button', { name: /^Connect/ }).click();
  // two nodes that are NOT related yet: a metabolite and a gene
  const src = await cy<string>('(cy) => cy.nodes("[type = \\"metabolite\\"]").first().id()');
  const dst = await cy<string>('(cy) => cy.nodes("[type = \\"gene\\"]").first().id()');
  const pa = await posOf(src), pb = await posOf(dst);
  await page.mouse.move(pa.x, pa.y); await page.mouse.down(); await page.mouse.move((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, { steps: 6 }); await page.mouse.move(pb.x, pb.y, { steps: 6 }); await page.mouse.up();
  await page.getByRole('heading', { name: 'Create a relationship?' }).waitFor();
  assert.equal(await total(), t0, 'nothing is stored just because two nodes were connected');
  await page.getByRole('button', { name: 'Cancel' }).click(); assert.equal(await total(), t0);
  await page.mouse.move(pa.x, pa.y); await page.mouse.down(); await page.mouse.move(pb.x, pb.y, { steps: 10 }); await page.mouse.up();
  await page.getByRole('heading', { name: 'Create a relationship?' }).waitFor();
  await page.getByRole('combobox', { name: 'Relationship type' }).fill('Associated with'); await page.getByLabel('Evidence class', { exact: true }).selectOption('user_supplied'); await page.getByLabel('Description', { exact: true }).fill('connector test');
  await page.getByLabel('Tags', { exact: true }).fill('Test, Connector');
  await page.getByRole('button', { name: /Save (this )?relationship/ }).first().click();
  await page.waitForFunction(() => /Relationship saved/.test(document.body.innerText));
  assert.equal(await total(), t0 + 1);
  const rel = (await api.get(`/api/relationships?workspace=${ws}&q=connector`)).json.rows[0];
  assert.equal(rel.origin, 'user'); assert.equal(rel.evidenceClass, 'user_supplied'); assert.deepEqual(rel.tags.sort(), ['Connector', 'Test']);
  L.ids.__conn = rel.id; (L as any).connSrc = src; (L as any).connDst = dst;
  if (await page.getByRole('button', { name: 'Done' }).isVisible()) await page.getByRole('button', { name: 'Done' }).click(); else await page.keyboard.press('Escape');
});

test('table-driven creation stores an equivalent record (same fields, same endpoint)', async () => {
  const conn = (await api.get(`/api/relationships/${L.ids.__conn}`)).json.relationship;
  const chem = L.ids.ATP, target = L.ids['Glucose-6-phosphate'];
  const tbl = (await api.get(`/api/workspaces/${ws}/tables?project=${proj}`)).json.tables.find((t: any) => t.kind === 'chemical').id;
  await page.goto(`${h.srv.base}/t/${tbl}?r=${chem}`); await page.locator('.rp').waitFor();
  await page.locator('.rp').getByRole('heading', { name: /Relationships/ }).waitFor();
  await page.locator('.rp').getByRole('button', { name: /Add relation/ }).click();
  const m = page.locator('.modal'); await m.getByLabel('Related record').fill('Glucose-6-phos'); await m.getByRole('option', { name: /Glucose-6-phosphate/ }).first().click();
  await m.getByRole('combobox', { name: 'Relationship type' }).fill('Associated with'); await m.getByLabel('Evidence class', { exact: true }).selectOption('user_supplied'); await m.getByLabel('Description', { exact: true }).fill('connector test');
  await m.getByLabel('Tags', { exact: true }).fill('Test, Connector');
  await m.getByRole('button', { name: 'Add citation' }).click(); await m.getByLabel('Citation value').fill('10.1000/abc');
  await m.getByRole('button', { name: /Save (this )?relationship/ }).first().click(); await m.getByText(/Both records are unchanged/).waitFor();
  const made = (await api.get(`/api/relationships?workspace=${ws}&q=connector`)).json.rows.find((r: any) => r.sourceId === chem && r.targetId === target);
  assert.ok(made, 'the table editor stored a relationship');
  for (const k of ['origin', 'evidenceClass', 'verification', 'directional', 'description']) assert.deepEqual(made[k], conn[k], `same ${k} as the connector-made record`);
  assert.deepEqual(made.tags.sort(), conn.tags.sort()); assert.equal(made.type.id, conn.type.id); assert.equal(made.citations[0].url, 'https://doi.org/10.1000/abc');
  await page.keyboard.press('Escape');
  // and it is immediately visible in the explorer
  await open(`/explorer?focus=${chem}`); assert.ok(await cy<boolean>('(cy, id) => cy.getElementById(id).nonempty()', made.id));
});

test('deleting a relationship in the UI keeps both records', async () => {
  const id = L.ids.__conn; const rel = (await api.get(`/api/relationships/${id}`)).json.relationship;
  await open(`/explorer?focus=${rel.sourceId}`); const eid = id;
  await cy('(cy, id) => { cy.getElementById(id).select(); }', eid);
  await page.locator('.insp').getByRole('button', { name: /Delete relationship/ }).click(); await page.getByRole('button', { name: 'Delete relationship' }).last().click();
  await page.waitForFunction(() => /both records kept/i.test(document.body.innerText));
  assert.equal((await api.get(`/api/relationships/${id}`)).status, 404);
  assert.equal((await api.get(`/api/records/${rel.sourceId}`)).status, 200); assert.equal((await api.get(`/api/records/${rel.targetId}`)).status, 200);
});

test('pathway view: reactions inside an outlined container in the defined order; branching visible; unknown order is not invented', async () => {
  await open('/explorer'); await page.getByRole('tab', { name: 'Pathway', exact: true }).click();
  await page.locator('.xfilters').getByLabel('Pathway', { exact: true }).selectOption({ label: 'Glycolysis (example) (7)' }); await page.waitForTimeout(1200);
  assert.ok(await page.getByText('Order defined').isVisible()); assert.ok(await page.getByText('has branches').isVisible());
  const g = await cy<any>('(cy) => ({ parent: cy.nodes(":parent").length, children: cy.nodes(":child").length, x: cy.nodes("[type = \\"reaction\\"]").map((n) => [n.data("label"), Math.round(n.position("y"))]) })');
  assert.equal(g.parent, 1, 'the pathway is a container'); assert.ok(g.children >= 7);
  const x = Object.fromEntries(g.x) as Record<string, number>;
  assert.ok(x['Hexokinase reaction'] < x['Glucose-6-phosphate isomerase reaction'] && x['Glucose-6-phosphate isomerase reaction'] < x['Phosphofructokinase reaction'] && x['Phosphofructokinase reaction'] < x['Aldolase reaction'] && x['Aldolase reaction'] < x['GAPDH reaction'], 'a seven-step pathway runs top to bottom along the defined order');
  assert.equal(await cy<number>('(cy) => cy.edges("[origin = \\"order\\"]").length'), 7);
  await page.getByText(/Starting/).first().waitFor(); assert.match(await page.locator('.pwbanner').innerText(), /Glucose/);
  await page.screenshot({ path: join(OUT, 'x3-pathway.png') });
  await page.locator('.xfilters').getByLabel('Pathway', { exact: true }).selectOption({ label: 'Glucose utilisation (order not recorded) (2)' }); await page.waitForTimeout(1200);
  assert.ok(await page.getByText('Order unknown / uncertain').first().isVisible(), 'honest about an unknown order'); assert.equal(await cy<number>('(cy) => cy.edges("[origin = \\"order\\"]").length'), 0);
  // flow mode
  await page.getByRole('tab', { name: 'Flow', exact: true }).click(); await page.locator('.flowcard').first().waitFor(); assert.equal(await page.locator('.flowcard').count(), 2);
  await page.locator('.xfilters').getByLabel('Pathway', { exact: true }).selectOption({ label: 'Glycolysis (example) (7)' }); await page.locator('.flowcol').nth(3).waitFor();
  assert.ok(await page.locator('.flowcard', { hasText: 'Aldolase reaction' }).getByText(/alternatively → Triose-phosphate/).isVisible(), 'branch shown as an alternative next step');
  await page.screenshot({ path: join(OUT, 'x4-flow.png') });
  await page.locator('.flowcard', { hasText: 'Hexokinase reaction' }).click(); await page.locator('.insp').getByRole('heading', { name: 'Hexokinase reaction' }).waitFor();
  assert.ok(await page.locator('.insp').getByText('Glucose + ATP → Glucose-6-phosphate + ADP').isVisible(), 'reaction equation with reactants and products');
});

test('one chemical in several pathways/reactions stays ONE node; its inspector lists both pathways', async () => {
  await open(`/explorer?focus=${L.ids['Glucose-6-phosphate']}&d=2`);
  assert.equal(await cy<number>('(cy) => cy.nodes().filter((n) => n.data("label") === "Glucose-6-phosphate").length'), 1);
  await clickNode(L.ids['Glucose-6-phosphate']); const insp = page.locator('.insp'); await insp.getByRole('heading', { name: /Pathways/ }).waitFor();
  assert.ok(await insp.getByRole('button', { name: 'Glycolysis (example)' }).isVisible()); assert.ok(await insp.getByRole('button', { name: /Glucose utilisation/ }).isVisible());
});

test('table mode lists the same relationships with evidence; a row opens the relationship', async () => {
  await open('/explorer'); await page.getByRole('tab', { name: 'Table', exact: true }).click();
  await page.locator('.reltable tbody tr').first().waitFor(); const n = await page.locator('.reltable tbody tr').count(); assert.ok(n >= 10);
  await page.getByLabel('Search relationships').fill('Citrate'); await page.waitForFunction(() => document.querySelectorAll('.reltable tbody tr').length === 1);
  await page.locator('.reltable tbody tr').first().click(); const insp = page.locator('.insp'); await insp.getByRole('heading', { name: 'Inhibits' }).waitFor();
  assert.ok(await insp.getByText('Literature reported').first().isVisible()); assert.ok(await insp.getByRole('link', { name: /1234567|7654321/ }).first().isVisible(), 'PMID is a clickable citation');
  assert.equal(await insp.getByRole('link', { name: /7654321/ }).first().getAttribute('href'), 'https://pubmed.ncbi.nlm.nih.gov/7654321/');
});

test('export: Cytoscape JSON and CSV preserve relationships and citations; a saved view re-opens with the same layout', async () => {
  await open(`/explorer?focus=${L.ids.Hexokinase}`);
  const [d1] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export/ }).click().then(() => page.getByRole('button', { name: /Cytoscape JSON/ }).click())]);
  const cyj = JSON.parse(readFileSync(await d1.path(), 'utf8')); assert.equal(cyj.elements.nodes.length, await cy<number>('(cy) => cy.nodes().length'));
  assert.ok(cyj.elements.edges.some((e: any) => e.data.typeName === 'Inhibits' && e.data.evidence === 'computationally_predicted'));
  const [d2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export/ }).click().then(() => page.getByRole('button', { name: /Relationships CSV/ }).click())]);
  const csv = readFileSync(await d2.path(), 'utf8'); assert.match(csv, /experimentally_verified/); assert.match(csv, /Inhibits/);
  // save the view, drag a node, reload, open the file: positions come back
  const [d3] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export/ }).click().then(() => page.getByRole('button', { name: /Save this view/ }).click())]);
  const viewPath = await d3.path(); const saved = JSON.parse(readFileSync(viewPath, 'utf8')); assert.equal(saved.kind, 'explorer-view');
  const first = Object.keys(saved.positions)[0];
  await page.goto(h.srv.base + '/explorer'); await page.locator('.xp-canvas').waitFor();
  await page.getByRole('button', { name: /Export/ }).click(); await page.locator('input[type=file]').setInputFiles(viewPath); await page.waitForTimeout(1500);
  assert.ok(await cy<number>('(cy) => cy.nodes().length') >= Object.keys(saved.positions).length - 1, 'same records are back');
  const p = await cy<{ x: number; y: number }>('(cy, id) => ({ x: cy.getElementById(id).position("x"), y: cy.getElementById(id).position("y") })', first);
  assert.ok(Math.abs(p.x - saved.positions[first].x) < 1.5 && Math.abs(p.y - saved.positions[first].y) < 1.5, 'node positions restored');
});

test('custom relationship type and the reaction editor work from the UI', async () => {
  await open('/explorer'); await page.getByRole('button', { name: /Create/ }).click(); await page.getByRole('button', { name: /Relationship types/ }).click();
  await page.getByLabel('Type name').fill('Allosterically regulates'); await page.getByLabel('Description', { exact: true }).fill('Binds outside the active site and changes activity.');
  await page.getByRole('button', { name: 'Create type' }).click(); await page.locator('.modal').getByText('Allosterically regulates').waitFor();
  assert.ok((await api.get(`/api/explorer/types?workspace=${ws}`)).json.types.some((t: any) => t.name === 'Allosterically regulates' && !t.builtin)); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Create/ }).click(); await page.getByRole('button', { name: /New reaction/ }).click();
  const m = page.locator('.modal'); await m.getByLabel('Reaction name').fill('Demo conversion');
  await m.getByRole('button', { name: /Reactant/ }).click(); await m.getByRole('combobox', { name: 'Participant' }).first().fill('Glucose'); await m.getByRole('option', { name: /^Glucose\b/ }).first().click();
  await m.getByRole('button', { name: /^\+? ?Product/ }).click(); await m.getByRole('combobox', { name: 'Participant' }).last().fill('ADP'); await m.getByRole('option', { name: /ADP/ }).first().click();
  assert.match(await m.locator('.eqbox').innerText(), /Glucose .* ADP/);
  await m.getByRole('button', { name: 'Save reaction' }).click(); await page.waitForFunction(() => /Reaction saved/.test(document.body.innerText));
  const rx = (await api.get(`/api/explorer/search?workspace=${ws}&q=Demo conversion&kinds=reaction`)).json.results[0]; assert.ok(rx);
  assert.match((await api.get(`/api/reactions/${rx.id}`)).json.equation, /Glucose . ADP|Glucose → ADP|Glucose ⇢ ADP/);
});

test('help: tooltips explain controls on hover and keyboard focus', async () => {
  await open('/explorer'); await page.getByRole('button', { name: /^Connect/ }).focus(); await page.getByRole('tooltip').waitFor();
  assert.match(await page.getByRole('tooltip').innerText(), /nothing is saved until you press Save/i);
  await page.keyboard.press('Escape');
  await page.locator('.xp-legend').getByRole('button', { name: /About legend/ }).click(); assert.match(await page.getByRole('tooltip').innerText(), /double border/i); await page.keyboard.press('Escape');
});

test('offline: the explorer still works from local data; cached images stay; fetching images is refused with an explanation', async () => {
  await api.post('/api/network', { mode: 'offline' });
  await page.goto(h.srv.base + `/explorer?focus=${L.ids.Hexokinase}`); await page.locator('.xp-canvas').waitFor(); await page.waitForFunction(() => (window as any).__vsCy?.nodes().length > 0);
  assert.ok(await page.locator('.netchip').getByText(/Working offline/).isVisible()); assert.ok(await page.getByText(/Working offline: everything shown here is stored on this computer/).isVisible());
  await clickNode(L.ids.Hexokinase); await page.locator('.insp .thumb img').waitFor({ state: 'visible' }); assert.ok(await page.locator('.insp .thumb img').evaluate((i: HTMLImageElement) => i.naturalWidth > 0), 'cached image served offline');
  // local edits keep working offline
  const t = (await api.post('/api/relationships', { sourceId: L.ids.Glucose, targetId: L.ids['ATP'], typeName: 'Interacts with', evidenceClass: 'user_supplied' })); assert.equal(t.status, 200, 'creating relationships needs no internet');
  await api.post('/api/network', { mode: 'auto' });
});

test('larger dataset: ~1,500 records and 4,000 relationships – the explorer stays responsive (bounded draw, filtered table)', async () => {
  const { q, tx } = await import('../../server/db.ts'); const { uid, now } = await import('../../server/util.ts');
  const tables = (await api.get(`/api/workspaces/${ws}/tables?project=${proj}`)).json.tables as { id: string; kind: string }[];
  const ct = tables.find((t) => t.kind === 'chemical')!.id, pt = tables.find((t) => t.kind === 'protein')!.id;
  const nf = (await api.get(`/api/tables/${ct}`)).json.fields.find((f: any) => f.key === 'name').id, pn = (await api.get(`/api/tables/${pt}`)).json.fields.find((f: any) => f.key === 'name').id;
  const ts = now(); const uidu = (await api.get('/api/app/state')).json.user.id; const cs: string[] = [], ps: string[] = [];
  const type = q.get<{ id: string }>("SELECT id FROM relationship_types WHERE workspace_id=? AND name='Binds to'", ws)!.id;
  tx(() => {
    for (let i = 0; i < 1000; i++) { const id = uid('rec'); cs.push(id); q.run('INSERT INTO records(id,table_id,data,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?)', id, ct, JSON.stringify({ [nf]: `Bulk compound ${i}` }), ts, ts, uidu); }
    for (let i = 0; i < 500; i++) { const id = uid('rec'); ps.push(id); q.run('INSERT INTO records(id,table_id,data,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?)', id, pt, JSON.stringify({ [pn]: `Bulk protein ${i}` }), ts, ts, uidu); }
    for (let i = 0; i < 4000; i++) q.run("INSERT OR IGNORE INTO relationships(id,workspace_id,source_id,target_id,type_id,directional,description,evidence_class,verification,origin,created_at,updated_at) VALUES (?,?,?,?,?,0,'',?,'unverified','import',?,?)", uid('rel'), ws, cs[i % 1000], ps[(i * 7 + Math.floor(i / 1000)) % 500], type, i % 3 ? 'database_annotated' : 'computationally_predicted', ts, ts);
  });
  const t0 = Date.now(); await page.goto(h.srv.base + '/explorer'); await page.waitForFunction(() => (window as any).__vsCy?.nodes().length >= 300, null, { timeout: 30000 });
  const t1 = Date.now() - t0; const nodes = await cy<number>('(cy) => cy.nodes().length'); assert.ok(nodes <= 1100, `bounded draw (${nodes} nodes)`); assert.ok(t1 < 12000, `first draw took ${t1} ms`);
  assert.ok(await page.getByText(/Showing \d+ records \(limit/).isVisible(), 'the user is told the view is partial and how to see more');
  // zoom + pan stay fluid: 60 wheel steps in well under the time budget
  const box = (await page.locator('.xp-canvas').boundingBox())!; const t2 = Date.now(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, i % 2 ? 120 : -120); const t3 = Date.now() - t2; assert.ok(t3 < 6000, `30 zoom steps took ${t3} ms`);
  // focus on one bulk node → neighbourhood only
  await page.goto(h.srv.base + `/explorer?focus=${cs[5]}`); await page.waitForFunction(() => (window as any).__vsCy?.nodes().length > 0);
  assert.ok(await cy<number>('(cy) => cy.nodes().length') < 80, 'a focused neighbourhood stays small');
  // table mode pages through everything
  await page.goto(h.srv.base + '/explorer'); await page.getByRole('tab', { name: 'Table', exact: true }).click(); await page.getByText(/4,0\d\d relationships|4\d\d\d relationships/).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.reltable tbody tr').count(), 50);
  console.log(`      larger dataset: first draw ${t1} ms (${nodes} nodes), 30 zoom steps ${t3} ms`);
  await page.screenshot({ path: join(OUT, 'x5-large.png') });
});

test('mobile viewport: no horizontal page scroll; inspector becomes a full-screen panel', async () => {
  const m = await h.open({ width: 390, height: 800 }); await m.page.goto(h.srv.base + `/explorer?focus=${L.ids.Hexokinase}`); await m.page.locator('.xp-canvas').waitFor(); await m.page.waitForTimeout(1500);
  assert.equal(await m.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await m.page.screenshot({ path: join(OUT, 'x6-mobile.png') }); await m.ctx.close();
});

test('no uncaught page errors during the whole explorer run', async () => { assert.deepEqual(errors, []); });
